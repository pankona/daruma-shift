// だるまおとし（Game Off 2026 試作）
// 物理は Matter.js、描画は Canvas 2D の自前描画。
(function () {
  'use strict';

  const { Engine, Bodies, Body, Composite, Events, Vertices, Sleeping } = Matter;

  // ---- 定数 ----------------------------------------------------------
  const W = 960;
  const H = 540;
  const FLOOR_Y = 512; // 床の上面
  const STEP_MS = 1000 / 60;

  const BLOCK_W = 120;
  const BLOCK_H = 36;
  const BLOCK_CORNER = 7; // 段の描画上の角の丸み（物理は四角のまま）
  // だるまは「上が丸く、下が平らな頭部だけのピース」。上の2隅だけ大きく面取りする。
  const DARUMA_W = 114;
  const DARUMA_H = 76;
  const DARUMA_TOP_R = 40;

  const MAX_DRAG = 160; // これ以上引いても強さは上がらない（論理px）
  const MIN_DRAG = 14; // これより短い引きはキャンセル
  const MAX_SPEED = 24; // 強さ1のときの初速（px/ステップ）
  const MAX_VERTICAL = 0.3; // 叩く向きの縦成分の上限

  const REST_SPEED = 0.12;
  const REST_ANGULAR = 0.012;
  const REST_FRAMES_EVAL = 45; // 静止がこのフレーム数続いたら評価
  const EVAL_TIMEOUT_STEPS = 6 * 60; // 叩いてから6秒で評価

  const WORRY_ANGLE = 0.35;

  // だるまの本番素材（ドット絵）。読み込めなかった場合は仮描画にフォールバックする。
  const darumaImage = new Image();
  let darumaImageReady = false;
  let darumaArtBox = null; // 画像内の「絵がある範囲」{x, y, w, h}（実ピクセル）
  darumaImage.onload = function () {
    try {
      darumaArtBox = measureArtBox(darumaImage);
    } catch (e) {
      darumaArtBox = null; // 測れなければ画像全体を使う
    }
    darumaImageReady = true;
  };
  darumaImage.onerror = function () {
    darumaImageReady = false;
  };
  darumaImage.src = 'assets/daruma.png';

  // 透明部分を除いた、絵が描かれている範囲を測る
  function measureArtBox(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height).data;
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  const BLOCK_TYPES = {
    normal: { friction: 0.35, frictionStatic: 0.6, density: 0.001 },
    slippery: { friction: 0.02, frictionStatic: 0.03, density: 0.001 },
    heavy: { friction: 0.35, frictionStatic: 0.6, density: 0.003 },
  };

  // ---- 面の定義 ------------------------------------------------------
  // platforms: 台（x は中心、top は上面、w は横幅）。台は床まで伸びる。
  // blocks: 下から順の段。stackOn の台の上に積み、stackX があればその位置に積む。
  // goal: 'lower' = 全部の段を抜いて、だるまを台の上に降ろす
  //       'carry' = だるまを target の台の上に運ぶ
  const STAGES = [
    {
      name: '面一　三段',
      goal: 'lower',
      platforms: [{ x: 480, top: 380, w: 160 }],
      stackOn: 0,
      blocks: ['normal', 'normal', 'normal'],
      target: 0,
    },
    {
      name: '面二　六段',
      goal: 'lower',
      platforms: [{ x: 480, top: 330, w: 160 }],
      stackOn: 0,
      blocks: ['normal', 'heavy', 'slippery', 'normal', 'heavy', 'slippery'],
      target: 0,
    },
    {
      name: '面三　向こう岸',
      goal: 'carry',
      // 右の台は低く、隙間（60）はだるまの一番細い向きの幅（高さ 76）より狭い（はまっても負けにはならない）。
      // 段を右寄りに積んであり、塔を右へ倒すとだるまが向こう岸へ届く。
      platforms: [
        { x: 270, top: 330, w: 180 },
        { x: 545, top: 400, w: 250 },
      ],
      stackOn: 0,
      stackX: 300,
      blocks: ['normal', 'normal', 'normal', 'normal', 'normal'],
      target: 1,
    },
  ];

  const GOAL_TEXT = {
    lower: '段を全部抜いて、だるまを台に降ろせ',
    carry: 'だるまを右の台へ運べ',
  };

  // ---- 状態 ----------------------------------------------------------
  const engine = Engine.create();
  engine.gravity.y = 1;
  engine.enableSleeping = true;

  let stageIndex = 0;
  let stage = null;
  let floor = null;
  let platforms = [];
  let blocks = []; // { body, type, removed }
  let daruma = null;
  let darumaShapeOffsetY = 0;

  // 'ready' | 'aiming' | 'moving' | 'won' | 'lost'
  let phase = 'ready';
  let result = null; // null | 'clear' | 'fail'
  let restFrames = 0;
  let stepsSinceStrike = 0;
  let evalPending = false; // 叩いた後の評価待ち
  let reEvalOnRest = false; // 6秒で評価したが未静止だった。静止したらもう一度評価
  let strikes = 0;
  let simSteps = 0;

  let aim = null; // { block, startX, startY, curX, curY, pointerId }

  const listeners = { result: [] };

  // ---- 面の構築 ------------------------------------------------------
  function loadStage(n) {
    const idx = Math.max(1, Math.min(STAGES.length, Math.floor(n))) - 1;
    stageIndex = idx;
    stage = STAGES[idx];

    Composite.clear(engine.world, false);
    Engine.clear(engine);

    floor = Bodies.rectangle(W / 2, FLOOR_Y + 40, 4000, 80, {
      isStatic: true,
      label: 'floor',
      friction: 0.6,
    });

    platforms = stage.platforms.map((p, i) => {
      const h = FLOOR_Y - p.top;
      const body = Bodies.rectangle(p.x, p.top + h / 2, p.w, h, {
        isStatic: true,
        label: 'platform',
        friction: 0.6,
        frictionStatic: 0.8,
      });
      return { body, x: p.x, top: p.top, w: p.w, index: i };
    });

    const base = stage.platforms[stage.stackOn];
    const sx = stage.stackX != null ? stage.stackX : base.x;
    blocks = stage.blocks.map((type, i) => {
      const props = BLOCK_TYPES[type];
      const body = Bodies.rectangle(sx, base.top - BLOCK_H / 2 - i * BLOCK_H, BLOCK_W, BLOCK_H, {
        label: 'block',
        friction: props.friction,
        frictionStatic: props.frictionStatic,
        density: props.density,
        restitution: 0,
      });
      return { body, type, removed: false, index: i };
    });

    const stackTop = base.top - stage.blocks.length * BLOCK_H;
    // chamfer の半径は 左上・右上・右下・左下 の順。下辺は平らに残す。
    daruma = Bodies.rectangle(sx, stackTop - DARUMA_H / 2, DARUMA_W, DARUMA_H, {
      label: 'daruma',
      chamfer: { radius: [DARUMA_TOP_R, DARUMA_TOP_R, 0, 0] },
      friction: 0.5,
      frictionStatic: 0.8,
      density: 0.0012,
      restitution: 0.05,
    });
    // 位置は重心（上が丸いぶん形の中心より下）。下辺が段の上面に乗るよう合わせる。
    Body.setPosition(daruma, {
      x: sx,
      y: daruma.position.y + (stackTop - daruma.bounds.max.y),
    });
    // 描画用：重心から見た外形の中心の縦のずれ
    darumaShapeOffsetY = (daruma.bounds.min.y + daruma.bounds.max.y) / 2 - daruma.position.y;

    Composite.add(engine.world, [floor, ...platforms.map((p) => p.body), ...blocks.map((b) => b.body), daruma]);

    phase = 'ready';
    result = null;
    restFrames = 0;
    stepsSinceStrike = 0;
    evalPending = false;
    reEvalOnRest = false;
    strikes = 0;
    simSteps = 0;
    aim = null;

    if (ui) ui.onStageLoaded();
  }

  Events.on(engine, 'collisionStart', (ev) => {
    if (phase === 'won' || phase === 'lost') return;
    for (const pair of ev.pairs) {
      const a = pair.bodyA;
      const b = pair.bodyB;
      if ((a === daruma && b === floor) || (b === daruma && a === floor)) {
        lose();
        return;
      }
    }
  });

  // ---- 進行 ----------------------------------------------------------
  function activeBlocks() {
    return blocks.filter((b) => !b.removed);
  }

  function dynamicBodies() {
    return [...activeBlocks().map((b) => b.body), daruma];
  }

  function maxMotion() {
    let speed = 0;
    let angular = 0;
    for (const body of dynamicBodies()) {
      speed = Math.max(speed, body.speed);
      angular = Math.max(angular, body.angularSpeed);
    }
    return { speed, angular };
  }

  function isOutOfBounds(body) {
    return body.position.x < -200 || body.position.x > W + 200 || body.position.y > H + 200;
  }

  function step() {
    Engine.update(engine, STEP_MS);
    simSteps++;

    // 画面外へ飛んだ段は世界から外す（以後「台の上から無くなった」扱い）
    for (const b of blocks) {
      if (!b.removed && isOutOfBounds(b.body)) {
        b.removed = true;
        Composite.remove(engine.world, b.body);
      }
    }
    if (phase !== 'lost' && phase !== 'won' && isOutOfBounds(daruma)) {
      lose();
    }

    const m = maxMotion();
    if (m.speed < REST_SPEED && m.angular < REST_ANGULAR) restFrames++;
    else restFrames = 0;

    if (phase === 'moving') {
      stepsSinceStrike++;
      if (evalPending && (restFrames >= REST_FRAMES_EVAL || stepsSinceStrike >= EVAL_TIMEOUT_STEPS)) {
        const settled = restFrames >= REST_FRAMES_EVAL;
        evalPending = false;
        evaluate();
        if (phase === 'moving') {
          phase = 'ready';
          reEvalOnRest = !settled;
        }
      }
    } else if (phase === 'ready' && reEvalOnRest && restFrames >= REST_FRAMES_EVAL) {
      reEvalOnRest = false;
      evaluate();
    }
  }

  // 静止を待たずに狙える。結果が出たあとと、すでに狙い中のときだけ不可
  function canAim() {
    return phase === 'ready' || phase === 'moving';
  }

  // 段が台（stage の stackOn の台）の上から無くなったか
  function blockOffPlatform(b, plat) {
    if (b.removed) return true;
    const body = b.body;
    if (isOutOfBounds(body)) return true;
    const half = plat.w / 2;
    if (body.position.x < plat.x - half || body.position.x > plat.x + half) return true;
    // 床の上にある（下端が床の高さ付近）
    if (body.bounds.max.y > FLOOR_Y - 4) return true;
    return false;
  }

  // だるまが台の上に静止しているか
  function darumaRestingOn(plat) {
    const p = daruma.position;
    const half = plat.w / 2;
    const onTop = Math.abs(daruma.bounds.max.y - plat.top) < 4;
    const inside = p.x >= plat.x - half && p.x <= plat.x + half;
    const still = daruma.speed < REST_SPEED * 2;
    return onTop && inside && still;
  }

  function evaluate() {
    if (phase === 'won' || phase === 'lost') return;
    let clear = false;
    if (stage.goal === 'lower') {
      const plat = platforms[stage.target];
      clear = blocks.every((b) => blockOffPlatform(b, plat)) && darumaRestingOn(plat);
    } else if (stage.goal === 'carry') {
      clear = darumaRestingOn(platforms[stage.target]);
    }
    if (clear) win();
  }

  function win() {
    phase = 'won';
    result = 'clear';
    aim = null;
    emitResult();
  }

  function lose() {
    if (phase === 'won' || phase === 'lost') return;
    phase = 'lost';
    result = 'fail';
    aim = null;
    emitResult();
  }

  function emitResult() {
    for (const fn of listeners.result) fn(result);
  }

  // 叩く向きを整える：縦成分を ±30% に制限し、単位ベクトルにする
  function clampDirection(dx, dy) {
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    let ny = dy / len;
    let nx = dx / len;
    ny = Math.max(-MAX_VERTICAL, Math.min(MAX_VERTICAL, ny));
    const sx = nx === 0 ? 1 : Math.sign(nx);
    nx = sx * Math.sqrt(1 - ny * ny);
    return { x: nx, y: ny };
  }

  function applyStrike(b, dirX, dirY, power) {
    const dir = clampDirection(dirX, dirY);
    if (!dir) return false;
    const p = Math.max(0, Math.min(1, power));
    if (p <= 0) return false;
    // 眠っているボディは setVelocity だけでは動かない。全ボディを起こしてから叩く。
    for (const body of dynamicBodies()) Sleeping.set(body, false);
    Body.setVelocity(b.body, { x: dir.x * p * MAX_SPEED, y: dir.y * p * MAX_SPEED });
    phase = 'moving';
    restFrames = 0;
    stepsSinceStrike = 0;
    evalPending = true;
    reEvalOnRest = false;
    strikes++;
    return true;
  }

  // ---- 狙い（ポインター） --------------------------------------------
  function blockAt(x, y) {
    const pt = { x, y };
    // 上の段から順に調べる
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.removed) continue;
      if (Vertices.contains(b.body.vertices, pt)) return b;
    }
    return null;
  }

  function aimVector() {
    if (!aim) return null;
    const dx = aim.startX - aim.curX;
    const dy = aim.startY - aim.curY;
    const len = Math.hypot(dx, dy);
    if (len < MIN_DRAG) return { cancel: true, len };
    const dir = clampDirection(dx, dy);
    const power = Math.min(len / MAX_DRAG, 1);
    return { cancel: false, dir, power, len };
  }

  function beginAim(x, y, pointerId) {
    if (!canAim()) return false;
    const b = blockAt(x, y);
    if (!b) return false;
    // prevPhase：キャンセル時に戻す phase（'moving' 中の評価待ちを壊さないため）
    aim = { block: b, startX: x, startY: y, curX: x, curY: y, pointerId, prevPhase: phase };
    phase = 'aiming'; // この間は物理を止める
    return true;
  }

  function moveAim(x, y) {
    if (!aim) return;
    aim.curX = x;
    aim.curY = y;
  }

  function endAim() {
    if (!aim) return;
    const v = aimVector();
    const b = aim.block;
    const prevPhase = aim.prevPhase;
    aim = null;
    phase = prevPhase;
    if (v && !v.cancel) applyStrike(b, v.dir.x, v.dir.y, v.power);
  }

  function cancelAim() {
    if (!aim) return;
    phase = aim.prevPhase;
    aim = null;
  }

  // ---- 描画 ----------------------------------------------------------
  const INK = '#2a2522';
  const PAPER = '#f3ead8';

  const BLOCK_STYLE = {
    normal: { fill: '#d39a5e', grain: '#a86f3a' },
    slippery: { fill: '#9fd4e2', grain: '#e9f7fb' },
    heavy: { fill: '#5b3a28', grain: '#7d5640' },
  };

  function drawScene(ctx) {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);

    // 遠景：薄い山の稜線
    ctx.strokeStyle = 'rgba(42,37,34,0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 360);
    ctx.quadraticCurveTo(180, 300, 330, 350);
    ctx.quadraticCurveTo(520, 280, 700, 340);
    ctx.quadraticCurveTo(840, 300, 960, 345);
    ctx.stroke();

    // 床
    ctx.fillStyle = '#e4d6b8';
    ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, FLOOR_Y);
    ctx.lineTo(W, FLOOR_Y);
    ctx.stroke();

    // 台
    for (const p of platforms) drawPlatform(ctx, p);

    // 段
    for (const b of blocks) if (!b.removed) drawBlock(ctx, b);

    drawDaruma(ctx, daruma);

    if (aim) drawAim(ctx);

    // 操作の手引き
    ctx.fillStyle = 'rgba(42,37,34,0.55)';
    ctx.font = '15px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const hint = canAim() ? '段を押さえて引き、離すと叩く' : phase === 'moving' ? '……' : '';
    if (hint && (phase === 'ready' || phase === 'moving')) ctx.fillText(hint, W / 2, FLOOR_Y + 14);
  }

  function drawPlatform(ctx, p) {
    const left = p.x - p.w / 2;
    const h = FLOOR_Y - p.top;
    ctx.fillStyle = '#3d322b';
    ctx.fillRect(left, p.top, p.w, h);
    // 天板
    ctx.fillStyle = '#8c2f24';
    ctx.fillRect(left - 6, p.top, p.w + 12, 10);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.strokeRect(left - 6, p.top, p.w + 12, 10);
    ctx.strokeRect(left, p.top + 10, p.w, h - 10);

    // 運ぶ先の台に印
    if (stage.goal === 'carry' && p.index === stage.target && phase !== 'won') {
      ctx.save();
      ctx.strokeStyle = 'rgba(179,38,30,0.6)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.strokeRect(left + 10, p.top - 92, p.w - 20, 86);
      ctx.restore();
      ctx.fillStyle = 'rgba(179,38,30,0.75)';
      ctx.font = '16px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ここへ', p.x, p.top - 49);
    }
  }

  function drawBlock(ctx, b) {
    const body = b.body;
    const st = BLOCK_STYLE[b.type];
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    const hw = BLOCK_W / 2;
    const hh = BLOCK_H / 2;

    const hovered = aim && aim.block === b;
    roundRectPath(ctx, -hw, -hh, BLOCK_W, BLOCK_H, BLOCK_CORNER);
    ctx.fillStyle = st.fill;
    ctx.fill();
    ctx.save();
    ctx.clip(); // 木目が角の丸みからはみ出さないように

    // 木目／つや
    ctx.strokeStyle = st.grain;
    ctx.lineWidth = b.type === 'slippery' ? 2.5 : 1.2;
    ctx.beginPath();
    if (b.type === 'slippery') {
      ctx.moveTo(-hw + 12, -hh + 8);
      ctx.lineTo(-hw + 40, -hh + 8);
      ctx.moveTo(-hw + 50, -hh + 8);
      ctx.lineTo(-hw + 58, -hh + 8);
    } else {
      ctx.moveTo(-hw + 6, -6);
      ctx.bezierCurveTo(-20, -10, 10, -2, hw - 6, -7);
      ctx.moveTo(-hw + 6, 5);
      ctx.bezierCurveTo(-25, 1, 20, 9, hw - 6, 4);
    }
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = INK;
    ctx.lineWidth = hovered ? 3 : 2;
    roundRectPath(ctx, -hw, -hh, BLOCK_W, BLOCK_H, BLOCK_CORNER);
    ctx.stroke();

    if (b.type === 'heavy') {
      ctx.fillStyle = 'rgba(243,234,216,0.75)';
      ctx.font = '16px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('重', 0, 1);
    }
    ctx.restore();
  }

  // 角丸の四角のパス。r は [左上, 右上, 右下, 左下] か一つの数。
  function roundRectPath(ctx, x, y, w, h, r) {
    const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr);
    ctx.lineTo(x + w, y + h - br);
    if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
    ctx.lineTo(x + bl, y + h);
    if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl);
    ctx.lineTo(x, y + tl);
    if (tl) ctx.arcTo(x, y, x + tl, y, tl);
    ctx.closePath();
  }

  function drawDaruma(ctx, body) {
    if (darumaImageReady) {
      drawDarumaImage(ctx, body);
      return;
    }
    drawDarumaProcedural(ctx, body);
  }

  // 本番素材のドット絵で描く。絵の高さを物理ボディの高さに合わせ、
  // 絵の下端とボディの下端をそろえ、横は中央合わせにする。
  function drawDarumaImage(ctx, body) {
    const img = darumaImage;
    const box = darumaArtBox || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    const scale = DARUMA_H / box.h;
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    const dx = -(box.x + box.w / 2) * scale;
    const dy = DARUMA_H / 2 - (box.y + box.h) * scale;
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    // 物理の位置は重心なので、外形の中心へずらしてから描く
    ctx.translate(0, darumaShapeOffsetY);
    ctx.imageSmoothingEnabled = false; // ドット絵をくっきり見せる
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  // 仮描画（画像が読み込めなかった場合のフォールバック）
  function drawDarumaProcedural(ctx, body) {
    const hw = DARUMA_W / 2;
    const hh = DARUMA_H / 2;
    const worried = Math.abs(normalizeAngle(body.angle)) > WORRY_ANGLE || phase === 'lost';
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    // 物理の位置は重心なので、外形の中心へずらしてから描く
    ctx.translate(0, darumaShapeOffsetY);

    // 頭（上が丸く、下が平ら）
    roundRectPath(ctx, -hw, -hh, DARUMA_W, DARUMA_H, [DARUMA_TOP_R, DARUMA_TOP_R, 0, 0]);
    ctx.fillStyle = '#c8322b';
    ctx.fill();
    ctx.save();
    ctx.clip();
    // 下の縁の金の帯
    ctx.fillStyle = '#d9a83a';
    ctx.fillRect(-hw, hh - 9, DARUMA_W, 4);
    ctx.restore();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 顔
    ctx.fillStyle = '#fbf6ea';
    ctx.beginPath();
    ctx.ellipse(0, -3, 31, 21, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 目
    ctx.fillStyle = INK;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * 12, -3, worried ? 3.2 : 4.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 眉
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.6;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      if (worried) {
        // 八の字（内側が上がる）
        ctx.moveTo(sx * 5, -19);
        ctx.lineTo(sx * 20, -12);
      } else {
        // 太く凛々しい眉（内側が下がる）
        ctx.moveTo(sx * 5, -11);
        ctx.quadraticCurveTo(sx * 13, -20, sx * 22, -15);
      }
      ctx.stroke();
    }

    // 口
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (worried) {
      ctx.moveTo(-6, 10);
      ctx.quadraticCurveTo(-3, 7, 0, 10);
      ctx.quadraticCurveTo(3, 13, 6, 10);
    } else {
      ctx.moveTo(-5, 8);
      ctx.quadraticCurveTo(0, 12, 5, 8);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawAim(ctx) {
    const v = aimVector();
    const body = aim.block.body;
    const cx = body.position.x;
    const cy = body.position.y;

    // 引いている線（薄く）
    ctx.strokeStyle = 'rgba(42,37,34,0.25)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(aim.startX, aim.startY);
    ctx.lineTo(aim.curX, aim.curY);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!v || v.cancel) return;

    const len = 30 + v.power * 140;
    const ex = cx + v.dir.x * len;
    const ey = cy + v.dir.y * len;
    const strong = v.power >= 1;
    ctx.strokeStyle = strong ? '#b3261e' : INK;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 3 + v.power * 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    const ang = Math.atan2(v.dir.y, v.dir.x);
    const head = 14 + v.power * 6;
    ctx.beginPath();
    ctx.moveTo(ex + Math.cos(ang) * head * 0.6, ey + Math.sin(ang) * head * 0.6);
    ctx.lineTo(ex + Math.cos(ang + 2.5) * head, ey + Math.sin(ang + 2.5) * head);
    ctx.lineTo(ex + Math.cos(ang - 2.5) * head, ey + Math.sin(ang - 2.5) * head);
    ctx.closePath();
    ctx.fill();
  }

  function normalizeAngle(a) {
    const t = Math.PI * 2;
    a = ((a % t) + t) % t;
    return a > Math.PI ? a - t : a;
  }

  // ---- 画面・入力 ----------------------------------------------------
  let ui = null;

  function setupUI() {
    const wrap = document.getElementById('stage-wrap');
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const stageName = document.getElementById('stage-name');
    const resultEl = document.getElementById('result');
    const resultText = document.getElementById('result-text');
    const btnRetry = document.getElementById('btn-retry');
    const btnNext = document.getElementById('btn-next');
    const stageBtns = Array.from(document.querySelectorAll('.stage-btn'));

    let scale = 1;
    function resize() {
      scale = Math.min(window.innerWidth / W, window.innerHeight / H);
      const ox = (window.innerWidth - W * scale) / 2;
      const oy = (window.innerHeight - H * scale) / 2;
      wrap.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(W * scale * dpr);
      canvas.height = Math.round(H * scale * dpr);
    }
    window.addEventListener('resize', resize);
    resize();

    function toLogical(ev) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((ev.clientX - rect.left) * W) / rect.width,
        y: ((ev.clientY - rect.top) * H) / rect.height,
      };
    }

    canvas.addEventListener('pointerdown', (ev) => {
      if (aim) return;
      const p = toLogical(ev);
      if (beginAim(p.x, p.y, ev.pointerId)) {
        canvas.setPointerCapture(ev.pointerId);
        ev.preventDefault();
      }
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!aim || ev.pointerId !== aim.pointerId) return;
      const p = toLogical(ev);
      moveAim(p.x, p.y);
    });
    canvas.addEventListener('pointerup', (ev) => {
      if (!aim || ev.pointerId !== aim.pointerId) return;
      const p = toLogical(ev);
      moveAim(p.x, p.y);
      endAim();
    });
    canvas.addEventListener('pointercancel', (ev) => {
      if (aim && ev.pointerId === aim.pointerId) cancelAim();
    });

    for (const btn of stageBtns) {
      btn.addEventListener('click', () => loadStage(Number(btn.dataset.stage)));
    }
    document.getElementById('btn-reset').addEventListener('click', () => loadStage(stageIndex + 1));
    btnRetry.addEventListener('click', () => loadStage(stageIndex + 1));
    btnNext.addEventListener('click', () => loadStage(((stageIndex + 1) % STAGES.length) + 1));

    listeners.result.push((r) => {
      resultText.textContent = r === 'clear' ? 'おみごと' : 'だるまが落ちた';
      resultText.className = r === 'clear' ? 'win' : 'lose';
      btnNext.textContent = stageIndex === STAGES.length - 1 ? '最初の面へ' : '次の面';
      // 失敗表示は少しだけ間を置いて、落ちる様子を見せる
      setTimeout(() => {
        if (result === r) resultEl.hidden = false;
      }, r === 'clear' ? 300 : 700);
    });

    // 固定ステップのループ。狙っている間はエンジンの更新を止める。
    let last = performance.now();
    let acc = 0;
    function frame(now) {
      const dt = Math.min(now - last, 100);
      last = now;
      if (phase === 'aiming') {
        acc = 0;
      } else {
        acc += dt;
        let n = 0;
        while (acc >= STEP_MS && n < 4) {
          step();
          acc -= STEP_MS;
          n++;
        }
        if (n === 4) acc = 0;
      }
      const k = canvas.width / W;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawScene(ctx);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return {
      onStageLoaded() {
        stageName.textContent = `${stage.name}　―　${GOAL_TEXT[stage.goal]}`;
        resultEl.hidden = true;
        stageBtns.forEach((b, i) => b.classList.toggle('current', i === stageIndex));
      },
    };
  }

  // ---- テスト用の口 --------------------------------------------------
  function bodyState(body) {
    return {
      x: body.position.x,
      y: body.position.y,
      angle: body.angle,
      vx: body.velocity.x,
      vy: body.velocity.y,
      speed: body.speed,
    };
  }

  window.__game = {
    // 段を番号（下から0始まり）で指定して叩く。dirX/dirY は向き、power は 0〜1。
    // 通常の操作と同じく、動いている最中でも叩ける。結果が出たあと（won/lost）は叩けない（false を返す）。
    strike(index, dirX, dirY, power) {
      const b = blocks[index];
      if (!b || b.removed || !canAim()) return false;
      return applyStrike(b, dirX, dirY, power);
    },
    state() {
      const target = platforms[stage.target];
      return {
        stage: stageIndex + 1,
        stageName: stage.name,
        goal: stage.goal,
        phase,
        result,
        canAim: canAim(),
        restFrames,
        strikes,
        simSteps,
        daruma: { ...bodyState(daruma), onTarget: darumaRestingOn(target) },
        blocks: blocks.map((b) => ({
          index: b.index,
          type: b.type,
          removed: b.removed,
          offPlatform: blockOffPlatform(b, platforms[stage.stackOn]),
          ...(b.removed ? {} : bodyState(b.body)),
        })),
        platforms: platforms.map((p) => ({ x: p.x, top: p.top, w: p.w })),
      };
    },
    loadStage(n) {
      loadStage(n);
      return this.state();
    },
    // 物理を n ステップ同期で進める（自動テスト・ヘッドレス用）
    step(n = 1) {
      for (let i = 0; i < n; i++) if (phase !== 'aiming') step();
      return this.state();
    },
  };

  if (typeof document !== 'undefined') ui = setupUI();
  loadStage(1);
})();
