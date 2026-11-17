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

  // ---- 演出の調整値（ルールには関わらない） ----------------------------
  const HITSTOP_MS = [50, 90]; // power 0 → 1 で線形
  const SHAKE_MAX = 5; // 画面振動の上限（論理px）
  const SHAKE_MS = 130;
  const SLOWMO_FACTOR = 0.35;
  const SLOWMO_MS = 500; // 実時間
  const LAND_MIN_SPEED = 1.2; // これより遅い接触は着地音を鳴らさない
  const LAND_COOLDOWN_STEPS = 10; // 同じボディの着地音の間隔
  // ヒヤリ：だるまが動いていて、台の端近くで大きく傾いている／端からはみ出している
  const DANGER_MOVING_SPEED = 0.25;
  const DANGER_MOVING_ANGULAR = 0.015;
  const DANGER_EDGE_DIST = 45; // 傾き判定に使う「端の近く」（だるまの中心から台の端まで）
  const DANGER_OVERHANG = DARUMA_W * 0.2; // はみ出し（約23px）
  // スローモーション：端からのはみ出し＋傾き or 角速度（ヒヤリより厳しめ）
  const TEETER_OVERHANG = DARUMA_W * 0.25; // 約29px
  const TEETER_TILT = 0.2;
  const TEETER_ANGULAR = 0.03;

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

    fx.reset();
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

  // 着地の音（演出のみ。判定には関わらない）
  Events.on(engine, 'collisionStart', (ev) => {
    if (phase === 'won' || phase === 'lost') return;
    for (const pair of ev.pairs) {
      fx.onContact(pair.bodyA, pair.bodyB);
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
    fx.onWin();
    emitResult();
  }

  function lose() {
    if (phase === 'won' || phase === 'lost') return;
    phase = 'lost';
    result = 'fail';
    aim = null;
    fx.onLose();
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
    fx.onStrike(b, dir, p);
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

  // 論理座標の世界を描く（カメラと振動の変換は呼び出し側でかける）
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
    fx.drawWorld(ctx);

    if (aim) drawAim(ctx);
  }

  // 画面に固定して描くもの（カメラの寄りや振動の影響を受けない）
  function drawOverlay(ctx) {
    // 操作の手引き
    ctx.fillStyle = 'rgba(42,37,34,0.55)';
    ctx.font = '15px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const hint = canAim() ? '段を押さえて引き、離すと叩く' : phase === 'moving' ? '……' : '';
    if (hint && (phase === 'ready' || phase === 'moving')) ctx.fillText(hint, W / 2, FLOOR_Y + 14);

    fx.drawOverlay(ctx);
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
    const st = BLOCK_STYLE[b.type];
    const ps = pose(b.body);
    ctx.save();
    ctx.translate(ps.x, ps.y);
    ctx.rotate(ps.angle);
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

  // 描画用の姿勢。スロー中は物理の1ステップが数フレームにまたがるので、
  // 次のステップまでの経過分を速度で先読みして滑らかに見せる（論理座標は変えない）。
  function pose(body) {
    const t = fx.renderLead();
    if (t <= 0) return { x: body.position.x, y: body.position.y, angle: body.angle };
    return {
      x: body.position.x + body.velocity.x * t,
      y: body.position.y + body.velocity.y * t,
      angle: body.angle + body.angularVelocity * t,
    };
  }

  // だるまの座標系へ移す：外形の中心が原点。ボディの傾きに、表情としての傾き（下端の中央が支点）を足す
  function applyDarumaTransform(ctx, body) {
    const ps = pose(body);
    ctx.translate(ps.x, ps.y);
    ctx.rotate(ps.angle);
    // 物理の位置は重心なので、外形の中心へずらしてから描く
    ctx.translate(0, darumaShapeOffsetY);
    const lean = fx.darumaLean();
    if (lean) {
      ctx.translate(0, DARUMA_H / 2);
      ctx.rotate(lean);
      ctx.translate(0, -DARUMA_H / 2);
    }
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
    applyDarumaTransform(ctx, body);
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
    applyDarumaTransform(ctx, body);

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
    const ps = pose(aim.block.body);
    const cx = ps.x;
    const cy = ps.y;

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

  // ---- 音（WebAudio の合成。素材ファイルは使わない） --------------------
  const sound = (function () {
    let ac = null;
    let out = null;
    let noise = null;
    let nextLandAt = 0;

    // 自動再生の制限があるので、最初のポインター操作で作る
    function init() {
      if (ac) {
        if (ac.state === 'suspended') ac.resume();
        return;
      }
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      ac = new AC();
      const comp = ac.createDynamicsCompressor();
      comp.connect(ac.destination);
      out = ac.createGain();
      out.gain.value = 0.6;
      out.connect(comp);
      noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.4), ac.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }

    function live() {
      return ac && ac.state === 'running';
    }

    // 音程つきの短い音。f0 から f1 へ滑らせ、指数で減衰させる
    function tone(f0, f1, at, dur, vol, type) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(f1, at + dur);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g);
      g.connect(out);
      o.start(at);
      o.stop(at + dur + 0.02);
    }

    // 雑音を帯域で絞った短い音（打撃の「カッ」、太鼓の皮鳴り）
    function hiss(at, dur, vol, type, freq, q) {
      const s = ac.createBufferSource();
      s.buffer = noise;
      const f = ac.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ac.createGain();
      g.gain.setValueAtTime(vol, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      s.connect(f);
      f.connect(g);
      g.connect(out);
      s.start(at);
      s.stop(at + dur + 0.02);
    }

    // 陽音階（レ・ミ・ソ・ラ・シ）の下から i 番目
    const YO = [0, 2, 5, 7, 9];
    function scale(i) {
      const semi = 12 * Math.floor(i / 5) + YO[i % 5];
      return 293.66 * Math.pow(2, semi / 12);
    }

    // 木の当たる音
    function wood(i, vol, at) {
      const f = scale(i);
      tone(f, f * 0.97, at, 0.18, 0.32 * vol, 'triangle');
      tone(f * 2.4, f * 2.3, at, 0.05, 0.1 * vol, 'sine');
      hiss(at, 0.02, 0.18 * vol, 'bandpass', f * 4, 2);
    }

    return {
      init,
      // 木槌：強く叩くほど大きく、音程も高い
      strike(p) {
        if (!live()) return;
        const t = ac.currentTime;
        const f = 240 + 260 * p;
        hiss(t, 0.05 + 0.03 * p, 0.25 + 0.5 * p, 'bandpass', 1200 + 1400 * p, 1.4);
        tone(f, f * 0.55, t, 0.1, 0.25 + 0.5 * p, 'triangle');
        tone(130, 70, t, 0.09, 0.15 + 0.35 * p, 'sine');
      },
      // 着地：同じ打撃の中で i 番目の着地。同時の着地は少しずらして階段に聞こえるようにする
      land(i, vol) {
        if (!live()) return;
        const at = Math.max(ac.currentTime, nextLandAt);
        nextLandAt = at + 0.045;
        wood(Math.min(i, 9), vol, at);
      },
      clear() {
        if (!live()) return;
        const t = ac.currentTime;
        // 太鼓の一打
        tone(95, 48, t, 0.55, 0.9, 'sine');
        hiss(t, 0.1, 0.35, 'lowpass', 350, 0.7);
        // 木の音の上昇
        [5, 6, 7, 9].forEach((n, k) => wood(n, k === 3 ? 1 : 0.8, t + 0.18 + k * 0.085));
      },
      fail() {
        if (!live()) return;
        tone(120, 72, ac.currentTime, 0.4, 0.45, 'triangle');
      },
    };
  })();

  // ---- 演出（ヒットストップ・振動・火花・表情・カメラ・スロー・クリア演出） ----
  // ゲームの状態は読むだけで書き換えない。Engine.update の刻み（STEP_MS）にも触れず、
  // ヒットストップとスローは「実時間に対して物理を何ステップ進めるか」だけで表す。
  // そのため __game.step() で進めるヘッドレスの結果は演出の有無で変わらない。
  const MINCHO = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
  const WA = { shu: '#d9482b', kin: '#d9a83a', shiro: '#fbf6ea', ai: '#2e4a7a' };

  // だるまが「ヒヤリ」「端で落ちるか止まるか」の状態か
  function darumaDanger() {
    const b = daruma.bounds;
    const tilt = Math.abs(normalizeAngle(daruma.angle));
    const angular = daruma.angularSpeed;
    const moving = daruma.speed > DANGER_MOVING_SPEED || angular > DANGER_MOVING_ANGULAR;
    // 支えの台：横に重なっていて、だるまの下端が上面より下がりきっていない台のうち一番高いもの
    let plat = null;
    for (const q of platforms) {
      if (b.max.x < q.x - q.w / 2 || b.min.x > q.x + q.w / 2) continue;
      if (b.max.y > q.top + 30) continue;
      if (!plat || q.top < plat.top) plat = q;
    }
    if (!plat) return { hiyari: false, teeter: false, overhang: 0, edgeDist: null, tilt, angular, moving };
    const l = plat.x - plat.w / 2;
    const r = plat.x + plat.w / 2;
    const overhang = Math.max(0, l - b.min.x, b.max.x - r);
    const edgeDist = Math.min(daruma.position.x - l, r - daruma.position.x); // 負なら重心が台の外
    const hiyari =
      moving && ((tilt > WORRY_ANGLE && edgeDist < DANGER_EDGE_DIST) || overhang > DANGER_OVERHANG);
    // 重心はまだ台の上、外形は端から大きくはみ出し、傾いているか回っている
    const teeter =
      moving && edgeDist > 0 && overhang > TEETER_OVERHANG && (tilt > TEETER_TILT || angular > TEETER_ANGULAR);
    return { hiyari, teeter, overhang, edgeDist, tilt, angular, moving };
  }

  const fx = (function () {
    let hitstopMs = 0;
    let shakeMs = 0;
    let shakeAmp = 0;
    let shakeX = 0;
    let shakeY = 0;
    let slowMs = 0;
    let slowUsed = false; // 1回の打撃につき1回まで
    let lead = 0; // 描画の先読み量（ステップ単位、スロー中だけ）
    let armed = false; // 一度でも叩いたか（面の最初の積み上がりで鳴らさない）
    let landSeq = 0;
    const lastLand = new Map(); // body.id → 最後に着地音を鳴らした simSteps
    let hiyariHold = 0;
    let hiyariZoomUsed = false;
    let lean = 0;
    let time = 0;
    let flash = null;
    let banner = null;
    const sparks = [];
    const petals = [];
    const cam = { z: 1, target: 1, holdMs: 0, fx: W / 2, fy: H / 2, cx: W / 2, cy: H / 2 };

    function reset() {
      hitstopMs = shakeMs = shakeX = shakeY = slowMs = lead = 0;
      slowUsed = armed = hiyariZoomUsed = false;
      landSeq = 0;
      lastLand.clear();
      hiyariHold = lean = 0;
      flash = banner = null;
      sparks.length = 0;
      petals.length = 0;
      Object.assign(cam, { z: 1, target: 1, holdMs: 0, fx: W / 2, fy: H / 2, cx: W / 2, cy: H / 2 });
    }

    function zoom(z, holdMs) {
      cam.target = Math.max(cam.target, z);
      cam.holdMs = Math.max(cam.holdMs, holdMs);
    }

    function darumaCenter() {
      return { x: (daruma.bounds.min.x + daruma.bounds.max.x) / 2, y: (daruma.bounds.min.y + daruma.bounds.max.y) / 2 };
    }

    function spawnSparks(x, y, dir, p) {
      const n = Math.round(5 + 9 * p);
      const back = Math.atan2(-dir.y, -dir.x); // 槌が来た側へ散る
      for (let i = 0; i < n; i++) {
        const ang = back + (Math.random() - 0.5) * 2.6;
        const sp = 0.15 + 0.25 * p + Math.random() * 0.2; // px/ms
        sparks.push({
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 0.12,
          life: 160 + Math.random() * 220,
          age: 0,
          color: Math.random() < 0.55 ? WA.kin : '#ffffff',
        });
      }
      flash = { x, y, age: 0 };
    }

    function spawnPetals() {
      const colors = [WA.shu, WA.kin, WA.shiro, WA.ai];
      for (let i = 0; i < 64; i++) {
        petals.push({
          x: Math.random() * W,
          y: -20 - Math.random() * 60,
          wait: Math.random() * 700,
          vy: 0.05 + Math.random() * 0.06,
          vx: -0.015 + Math.random() * 0.03,
          sway: 0.02 + Math.random() * 0.03,
          ph: Math.random() * Math.PI * 2,
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 0.006,
          flip: Math.random() * Math.PI * 2,
          size: 5 + Math.random() * 4,
          color: colors[i % colors.length],
          momiji: Math.random() < 0.4,
        });
      }
    }

    function makeBanner(text) {
      const dots = [];
      for (let i = 0; i < 9; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        dots.push({
          x: side * (60 + Math.random() * 150),
          y: (Math.random() - 0.5) * 120,
          r: 1.5 + Math.random() * 4.5,
        });
      }
      return { text, age: 0, rot: -0.05 - Math.random() * 0.04, dots };
    }

    return {
      reset,
      danger: darumaDanger,

      onStrike(b, dir, p) {
        armed = true;
        landSeq = 0;
        lastLand.clear();
        slowUsed = false;
        hiyariZoomUsed = false;
        hitstopMs = HITSTOP_MS[0] + (HITSTOP_MS[1] - HITSTOP_MS[0]) * p;
        shakeAmp = Math.min(SHAKE_MAX, 1 + 4 * p);
        shakeMs = SHAKE_MS;
        // 打点：槌が当たる側の面（叩く向きの反対側）
        spawnSparks(b.body.position.x - (dir.x * BLOCK_W) / 2, b.body.position.y - (dir.y * BLOCK_H) / 2, dir, p);
        sound.strike(p);
      },

      // 段が床・台に、だるまが台・段に着地したら木の音。同じ打撃の中では音程を1段ずつ上げる
      onContact(a, o) {
        if (!armed) return;
        for (const [m, other] of [
          [a, o],
          [o, a],
        ]) {
          const ground = other.label === 'floor' || other.label === 'platform';
          if (m.label === 'block') {
            if (!ground) continue;
          } else if (m === daruma) {
            if (other.label !== 'platform' && other.label !== 'block') continue; // 床は負けの音に任せる
          } else continue;
          if (m.speed < LAND_MIN_SPEED) continue;
          const prev = lastLand.get(m.id);
          if (prev != null && simSteps - prev < LAND_COOLDOWN_STEPS) continue;
          lastLand.set(m.id, simSteps);
          sound.land(landSeq++, Math.min(1, 0.35 + m.speed / 8));
        }
      },

      onWin() {
        slowMs = 0;
        banner = makeBanner(strikes === 1 ? '一撃' : 'お見事');
        spawnPetals();
        zoom(1.25, 1100);
        sound.clear();
      },

      onLose() {
        slowMs = 0;
        sound.fail();
      },

      hitstopActive() {
        return hitstopMs > 0;
      },

      // 実時間に対する物理の進み（スローは終わり際 120ms で通常へ戻す）
      timeFactor() {
        if (slowMs <= 0) return 1;
        if (slowMs < 120) return SLOWMO_FACTOR + (1 - SLOWMO_FACTOR) * (1 - slowMs / 120);
        return SLOWMO_FACTOR;
      },

      renderLead() {
        return lead;
      },

      darumaLean() {
        return lean;
      },

      mood() {
        if (phase === 'won') return 'relief';
        if (phase === 'aiming') return 'aim';
        if (hiyariHold > 0 && phase !== 'lost') return 'hiyari';
        return 'normal';
      },

      // dt：実時間（ms）、accSteps：次の物理ステップまでの経過（ステップ単位）
      update(dt, accSteps) {
        time += dt;
        const aiming = phase === 'aiming';
        if (hitstopMs > 0) hitstopMs -= dt;
        if (!aiming && slowMs > 0) slowMs -= dt;
        lead = slowMs > 0 && !aiming && hitstopMs <= 0 ? Math.min(1, accSteps) : 0;

        // ヒヤリとスローの判定
        if (phase === 'moving' || phase === 'ready') {
          const d = darumaDanger();
          if (d.hiyari) {
            hiyariHold = 400;
            if (phase === 'moving' && !hiyariZoomUsed) {
              hiyariZoomUsed = true;
              zoom(1.18, 700);
            }
          }
          if (phase === 'moving' && d.teeter && !slowUsed) {
            slowUsed = true;
            slowMs = SLOWMO_MS;
          }
        }
        if (hiyariHold > 0) hiyariHold -= dt;

        // 狙い中：狙う向きへわずかに傾き、強く引くほど小さく震える
        let leanTarget = 0;
        if (aiming) {
          const v = aimVector();
          if (v && !v.cancel) leanTarget = v.dir.x * (0.03 + 0.06 * v.power) + Math.sin(time * 0.06) * 0.012 * v.power;
        }
        lean += (leanTarget - lean) * (1 - Math.exp(-dt / 70));

        // カメラ（狙い中は止めて、ポインターの座標変換を安定させる）
        if (!aiming) {
          if (cam.holdMs > 0) cam.holdMs -= dt;
          else cam.target = 1;
          const k = 1 - Math.exp(-dt / 180);
          cam.z += (cam.target - cam.z) * k;
          const c = darumaCenter();
          cam.fx += (c.x - cam.fx) * k;
          cam.fy += (c.y + 20 - cam.fy) * k;
          const hw = W / (2 * cam.z);
          const hh = H / (2 * cam.z);
          cam.cx = Math.max(hw, Math.min(W - hw, cam.fx));
          cam.cy = Math.max(hh, Math.min(H - hh, cam.fy));
        }

        // 画面振動
        if (shakeMs > 0) {
          shakeMs -= dt;
          const a = shakeAmp * Math.pow(Math.max(0, shakeMs) / SHAKE_MS, 2);
          shakeX = (Math.random() * 2 - 1) * a;
          shakeY = (Math.random() * 2 - 1) * a;
        } else {
          shakeX = shakeY = 0;
        }

        for (let i = sparks.length - 1; i >= 0; i--) {
          const s = sparks[i];
          s.age += dt;
          s.vy += 0.0009 * dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          if (s.age >= s.life) sparks.splice(i, 1);
        }
        if (flash) {
          flash.age += dt;
          if (flash.age > 90) flash = null;
        }

        for (let i = petals.length - 1; i >= 0; i--) {
          const p = petals[i];
          if (p.wait > 0) {
            p.wait -= dt;
            continue;
          }
          p.ph += dt * 0.003;
          p.x += (p.vx + Math.sin(p.ph) * p.sway) * dt;
          p.y += p.vy * dt;
          p.rot += p.vr * dt;
          p.flip += dt * 0.006;
          if (p.y > H + 20) petals.splice(i, 1);
        }

        if (banner) banner.age += dt;
      },

      applyCamera(ctx) {
        ctx.translate(shakeX, shakeY);
        ctx.translate(W / 2, H / 2);
        ctx.scale(cam.z, cam.z);
        ctx.translate(-cam.cx, -cam.cy);
      },

      // 画面上の論理座標 → 世界の論理座標（振動は小さいので無視する）
      screenToWorld(x, y) {
        return { x: (x - W / 2) / cam.z + cam.cx, y: (y - H / 2) / cam.z + cam.cy };
      },

      drawWorld(ctx) {
        // 打点の閃き
        if (flash) {
          const k = flash.age / 90;
          ctx.save();
          ctx.globalAlpha = 1 - k;
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = WA.kin;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(flash.x, flash.y, 6 + 14 * k, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }

        // 火花（白は紙の地に溶けるので、薄い墨の縁を下に敷く）
        ctx.save();
        ctx.lineCap = 'round';
        for (const s of sparks) {
          const k = 1 - s.age / s.life;
          const tx = s.x - s.vx * 16;
          const ty = s.y - s.vy * 16;
          ctx.globalAlpha = Math.min(1, k * 1.5);
          ctx.strokeStyle = 'rgba(42,37,34,0.35)';
          ctx.lineWidth = 1.5 + 2.5 * k;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 0.6 + 1.8 * k;
          ctx.stroke();
        }
        ctx.restore();

        const mood = this.mood();
        const hw = DARUMA_W / 2;
        const hh = DARUMA_H / 2;

        // ヒヤリ：冷や汗の雫（だるまと一緒に傾ける）
        if (mood === 'hiyari') {
          const slide = ((time % 700) / 700) * 6;
          ctx.save();
          applyDarumaTransform(ctx, daruma);
          ctx.translate(hw - 4, -hh + 12 + slide);
          ctx.beginPath();
          ctx.moveTo(0, -9);
          ctx.bezierCurveTo(3, -3, 6, 1, 6, 4);
          ctx.arc(0, 4, 6, 0, Math.PI);
          ctx.bezierCurveTo(-6, 1, -3, -3, 0, -9);
          ctx.fillStyle = '#5b8fd0';
          ctx.fill();
          ctx.strokeStyle = WA.ai;
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.beginPath();
          ctx.arc(-2, 3, 1.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // 安堵：横に息のマーク（白い丸の連なりが流れて消える）
        if (mood === 'relief') {
          const c = pose(daruma);
          const ox = c.x + hw + 4;
          const oy = c.y + darumaShapeOffsetY - 2;
          ctx.save();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = 'rgba(42,37,34,0.5)';
          ctx.fillStyle = '#ffffff';
          for (let i = 0; i < 3; i++) {
            const ph = (time / 1100 + i / 3) % 1;
            ctx.globalAlpha = 1 - ph;
            ctx.beginPath();
            ctx.arc(ox + ph * 30, oy - ph * 14, 2 + ph * 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          ctx.restore();
        }
      },

      drawOverlay(ctx) {
        // 花びら紙吹雪
        for (const p of petals) {
          if (p.wait > 0) continue;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.scale(Math.max(0.15, Math.abs(Math.cos(p.flip))), 1);
          const s = p.size;
          ctx.beginPath();
          if (p.momiji) {
            // 紅葉：5つの尖り
            for (let i = 0; i < 10; i++) {
              const r = i % 2 === 0 ? s : s * 0.45;
              const a = -Math.PI / 2 + (i * Math.PI) / 5;
              if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
              else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
            }
            ctx.closePath();
          } else {
            // 桜：先に切れ込みのある花びら
            ctx.moveTo(0, s);
            ctx.bezierCurveTo(s * 0.9, s * 0.4, s * 0.7, -s * 0.8, s * 0.2, -s);
            ctx.lineTo(0, -s * 0.7);
            ctx.lineTo(-s * 0.2, -s);
            ctx.bezierCurveTo(-s * 0.7, -s * 0.8, -s * 0.9, s * 0.4, 0, s);
          }
          ctx.fillStyle = p.color;
          ctx.fill();
          ctx.strokeStyle = 'rgba(42,37,34,0.35)';
          ctx.lineWidth = 0.8;
          ctx.stroke();
          ctx.restore();
        }

        // 筆文字（一瞬だけ）
        const DUR = 1700;
        if (banner && banner.age < DUR) {
          const t = banner.age;
          const pop = t < 140 ? 1.5 - 0.5 * (1 - Math.pow(1 - t / 140, 3)) : 1;
          ctx.save();
          ctx.globalAlpha = t > DUR - 350 ? (DUR - t) / 350 : 1;
          ctx.translate(W / 2, 128);
          ctx.rotate(banner.rot);
          ctx.scale(pop, pop);
          // 墨の飛沫
          ctx.fillStyle = INK;
          for (const d of banner.dots) {
            ctx.beginPath();
            ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.font = `bold 112px ${MINCHO}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // にじみ（少しずらした薄墨）を下に敷く
          ctx.fillStyle = 'rgba(42,37,34,0.22)';
          ctx.fillText(banner.text, 4, 4);
          ctx.fillStyle = INK;
          ctx.fillText(banner.text, 0, 0);
          // 朱の落款
          const tw = ctx.measureText(banner.text).width;
          ctx.translate(tw / 2 + 24, 34);
          ctx.rotate(0.08);
          ctx.fillStyle = WA.shu;
          ctx.fillRect(-15, -15, 30, 30);
          ctx.fillStyle = WA.shiro;
          ctx.font = `bold 20px ${MINCHO}`;
          ctx.fillText('達', 0, 1);
          ctx.restore();
        }
      },
    };
  })();

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
      // カメラが寄っているときは、画面上の位置を世界の論理座標へ戻す
      return fx.screenToWorld(((ev.clientX - rect.left) * W) / rect.width, ((ev.clientY - rect.top) * H) / rect.height);
    }

    // 自動再生の制限への対策：最初のポインター操作で音を用意する（ボタンでも可）
    window.addEventListener('pointerdown', () => sound.init(), true);

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
      // 失敗表示は少しだけ間を置いて、落ちる様子を見せる。クリアは筆文字と寄りを先に見せる
      setTimeout(() => {
        if (result === r) resultEl.hidden = false;
      }, r === 'clear' ? 900 : 700);
    });

    // 固定ステップのループ。狙っている間とヒットストップ中はエンジンの更新を止める。
    // スロー中は実時間の進みを縮めて積む（1ステップの刻みは常に STEP_MS のまま）。
    let last = performance.now();
    let acc = 0;
    function frame(now) {
      const dt = Math.min(now - last, 100);
      last = now;
      if (phase === 'aiming' || fx.hitstopActive()) {
        acc = 0;
      } else {
        acc += dt * fx.timeFactor();
        let n = 0;
        while (acc >= STEP_MS && n < 4) {
          step();
          acc -= STEP_MS;
          n++;
        }
        if (n === 4) acc = 0;
      }
      fx.update(dt, acc / STEP_MS);
      const k = canvas.width / W;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      // 振動で端が覗いても紙色になるよう、先に全面を塗る
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      fx.applyCamera(ctx);
      drawScene(ctx);
      ctx.restore();
      drawOverlay(ctx);
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
    // 演出用の判定（ヒヤリ・スローの条件）の現在値。演出の調整・確認用
    danger() {
      return fx.danger();
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
