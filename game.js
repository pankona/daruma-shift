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
  // 目入れ用：画像の目の位置（画像の画素座標）。x, y は中心、rx, ry は目の範囲の半径、r は入れる瞳の半径。
  // 画素が読めないとき（file:// で開いた場合など、canvas が汚染されて getImageData が失敗する）は
  // 目視で決めた概算値を使い、顔色の楕円を重ねて元の目を隠す。
  const EYE_FALLBACK = [
    { x: 40, y: 45, rx: 6.5, ry: 6.5, r: 4 },
    { x: 56, y: 45, rx: 6.5, ry: 6.5, r: 4 },
  ];
  let darumaEyes = EYE_FALLBACK; // [向かって左, 向かって右]
  let darumaFaceColor = '#fffcf5'; // 目を隠す顔色（画素が読めれば顔の最頻色に置き換える）
  let darumaSprite = null; // 目の画素を顔色で消した複製（画素が読めたときだけ）
  darumaImage.onload = function () {
    let px = null;
    try {
      px = readPixels(darumaImage);
      darumaArtBox = measureArtBox(px);
    } catch (e) {
      darumaArtBox = null; // 測れなければ画像全体を使う
    }
    if (px) {
      try {
        const found = findEyes(px);
        if (found) {
          darumaEyes = found.eyes;
          darumaFaceColor = found.face;
          darumaSprite = makeBlankSprite(px, found);
        }
      } catch (e) {
        darumaSprite = null; // 見つからなければ概算値＋楕円のまま
      }
    }
    darumaImageReady = true;
  };
  darumaImage.onerror = function () {
    darumaImageReady = false;
  };
  darumaImage.src = 'assets/daruma.png';

  function readPixels(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
  }

  // 透明部分を除いた、絵が描かれている範囲を測る
  function measureArtBox(px) {
    const { w, h, data } = px;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) {
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

  // 画像の画素から目の位置を測る。
  // 顔（白っぽい画素）の枠の中にある墨の塊を連結成分に分け、白を囲んでいる（縁取りのある）丸い塊、
  // なければ丸い塊のうち、顔の中心をはさんで左右に対で並ぶものを目とみなす。
  // 返り値：{ eyes: [左, 右], face: 顔色の文字列, faceRGB: [r, g, b] }。見つからなければ null。
  // mask が 1 の画素を 4近傍でつないだ連結成分（枠 [bx0,bx1]×[by0,by1] の中だけ見る）
  function labelComponents(mask, w, bx0, by0, bx1, by1) {
    const label = new Int32Array(mask.length); // 0 = 未割り当て
    const comps = [];
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const k0 = y * w + x;
        if (!mask[k0] || label[k0]) continue;
        const id = comps.length + 1;
        const pixels = [];
        const stack = [k0];
        label[k0] = id;
        let cx0 = x, cy0 = y, cx1 = x, cy1 = y;
        while (stack.length) {
          const q = stack.pop();
          pixels.push(q);
          const qx = q % w;
          const qy = (q - qx) / w;
          if (qx < cx0) cx0 = qx;
          if (qx > cx1) cx1 = qx;
          if (qy < cy0) cy0 = qy;
          if (qy > cy1) cy1 = qy;
          for (const [nx, ny] of [[qx - 1, qy], [qx + 1, qy], [qx, qy - 1], [qx, qy + 1]]) {
            if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1) continue;
            const nk = ny * w + nx;
            if (mask[nk] && !label[nk]) {
              label[nk] = id;
              stack.push(nk);
            }
          }
        }
        comps.push({ id, pixels, area: pixels.length, x0: cx0, y0: cy0, x1: cx1, y1: cy1 });
      }
    }
    return { label, comps };
  }

  function findEyes(px) {
    const { w, h, data } = px;
    const n = w * h;
    const dark = new Uint8Array(n); // 墨：輝度 80 未満
    const white = new Uint8Array(n); // 白っぽい：顔と目の白
    for (let k = 0; k < n; k++) {
      const i = k * 4;
      if (data[i + 3] <= 8) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if ((r + g + b) / 3 < 80) dark[k] = 1;
      else if (r > 185 && g > 185 && b > 165) white[k] = 1;
    }

    // 顔：いちばん大きい白の連結成分（体のつやなど、小さな白は無視する）
    const faceComp = labelComponents(white, w, 0, 0, w - 1, h - 1).comps.sort((a, b) => b.area - a.area)[0];
    if (!faceComp) return null;
    const fx0 = faceComp.x0, fy0 = faceComp.y0, fx1 = faceComp.x1, fy1 = faceComp.y1;
    const faceW = fx1 - fx0 + 1;
    const faceH = fy1 - fy0 + 1;
    const faceCx = (fx0 + fx1 + 1) / 2;
    // 顔の色：顔の画素の最頻色
    const faceColors = new Map();
    for (const k of faceComp.pixels) {
      const i = k * 4;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      faceColors.set(key, (faceColors.get(key) || 0) + 1);
    }
    let faceKey = 0, faceMax = -1;
    for (const [key, cnt] of faceColors) {
      if (cnt > faceMax) {
        faceMax = cnt;
        faceKey = key;
      }
    }
    const faceRGB = [(faceKey >> 16) & 255, (faceKey >> 8) & 255, faceKey & 255];

    // 顔の枠（1px 広げる）の中の墨の連結成分
    const bx0 = Math.max(0, fx0 - 1), by0 = Math.max(0, fy0 - 1);
    const bx1 = Math.min(w - 1, fx1 + 1), by1 = Math.min(h - 1, fy1 + 1);
    const { label, comps } = labelComponents(dark, w, bx0, by0, bx1, by1);

    // 各成分が囲んでいる画素：成分の枠の縁から成分以外の画素をたどり、届かなかった画素
    for (const c of comps) {
      const ex0 = Math.max(0, c.x0 - 1), ey0 = Math.max(0, c.y0 - 1);
      const ex1 = Math.min(w - 1, c.x1 + 1), ey1 = Math.min(h - 1, c.y1 + 1);
      const seen = new Set();
      const stack = [];
      const push = (x, y) => {
        const k = y * w + x;
        if (label[k] === c.id || seen.has(k)) return;
        seen.add(k);
        stack.push(k);
      };
      for (let x = ex0; x <= ex1; x++) {
        push(x, ey0);
        push(x, ey1);
      }
      for (let y = ey0; y <= ey1; y++) {
        push(ex0, y);
        push(ex1, y);
      }
      while (stack.length) {
        const q = stack.pop();
        const qx = q % w;
        const qy = (q - qx) / w;
        if (qx > ex0) push(qx - 1, qy);
        if (qx < ex1) push(qx + 1, qy);
        if (qy > ey0) push(qx, qy - 1);
        if (qy < ey1) push(qx, qy + 1);
      }
      c.enclosed = [];
      for (let y = ey0; y <= ey1; y++) {
        for (let x = ex0; x <= ex1; x++) {
          const k = y * w + x;
          if (label[k] !== c.id && !seen.has(k)) c.enclosed.push(k);
        }
      }
      c.w = c.x1 - c.x0 + 1;
      c.h = c.y1 - c.y0 + 1;
      c.cx = (c.x0 + c.x1 + 1) / 2;
      c.cy = (c.y0 + c.y1 + 1) / 2;
    }

    const cands = comps.filter((c) => c.area <= (faceW * faceH) / 3 && c.w >= 2 && c.h >= 2);
    const round = (c) => c.w / c.h >= 0.5 && c.w / c.h <= 2;
    // 左右の対：横に離れ、高さがそろい、大きさが近く、中点が顔の中心の近く
    function pairs(list) {
      const out = [];
      for (const a of list) {
        for (const b of list) {
          if (a.cx >= b.cx || a.x1 >= b.x0) continue;
          if (Math.abs(a.cy - b.cy) > Math.max(a.h, b.h)) continue;
          if (Math.max(a.area, b.area) / Math.min(a.area, b.area) > 2.5) continue;
          if (Math.abs((a.cx + b.cx) / 2 - faceCx) > faceW * 0.15) continue;
          out.push([a, b]);
        }
      }
      return out;
    }
    let ps = pairs(cands.filter((c) => c.enclosed.length > 0 && round(c)));
    let solid = false; // 縁取りのない塗りつぶしの目
    if (!ps.length) {
      ps = pairs(cands.filter(round));
      solid = true;
    }
    let best = null;
    for (const p of ps) {
      const score = p[0].area + p[1].area + p[0].enclosed.length + p[1].enclosed.length;
      if (!best || score > best.score) best = { pair: p, score };
    }
    if (!best) return null;

    // 目の範囲：成分＋囲んだ画素＋成分の枠の中にある小さな墨の塊（縁取りが開いていて囲めなかった瞳など）。
    // 枠に少しかかる大きな塊（眉の端）は巻き込まない
    const eyes = best.pair.map((c) => {
      const region = new Set(c.pixels);
      for (const k of c.enclosed) region.add(k);
      for (let y = c.y0; y <= c.y1; y++) {
        for (let x = c.x0; x <= c.x1; x++) {
          const k = y * w + x;
          if (!dark[k] || label[k] === c.id) continue;
          const other = label[k] ? comps[label[k] - 1] : null;
          if (other && other.area < c.area * 0.6) region.add(k);
        }
      }
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (const k of region) {
        const x = k % w;
        const y = (k - x) / w;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      const rx = (x1 - x0 + 1) / 2;
      const ry = (y1 - y0 + 1) / 2;
      return {
        x: (x0 + x1 + 1) / 2,
        y: (y0 + y1 + 1) / 2,
        rx,
        ry,
        r: Math.max(1.5, (solid ? 0.8 : 0.6) * Math.min(rx, ry)),
        region,
      };
    });
    // 妥当性：丸い、大きさが近い、高さがそろう。外れていたら概算値に任せる
    for (const e of eyes) {
      const asp = e.rx / e.ry;
      if (asp < 0.55 || asp > 1.8 || e.rx < 2 || e.rx > faceW * 0.3) return null;
    }
    if (Math.abs(eyes[0].y - eyes[1].y) > 3) return null;
    if (Math.max(eyes[0].rx, eyes[1].rx) / Math.min(eyes[0].rx, eyes[1].rx) > 1.6) return null;
    return { eyes, face: `rgb(${faceRGB[0]},${faceRGB[1]},${faceRGB[2]})`, faceRGB };
  }

  // 目の画素を顔色で塗りつぶした複製を作る（「まだ目が入っていない」だるま）
  function makeBlankSprite(px, found) {
    const c = document.createElement('canvas');
    c.width = px.w;
    c.height = px.h;
    const g = c.getContext('2d');
    const id = g.createImageData(px.w, px.h);
    id.data.set(px.data);
    const [r, gg, b] = found.faceRGB;
    for (const e of found.eyes) {
      for (const k of e.region) {
        const i = k * 4;
        id.data[i] = r;
        id.data[i + 1] = gg;
        id.data[i + 2] = b;
        id.data[i + 3] = 255;
      }
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  const BLOCK_TYPES = {
    normal: { friction: 0.35, frictionStatic: 0.6, density: 0.001 },
    slippery: { friction: 0.02, frictionStatic: 0.03, density: 0.001 },
    heavy: { friction: 0.35, frictionStatic: 0.6, density: 0.003 },
  };

  // ---- 面の定義 ------------------------------------------------------
  // platforms: 台（x は中心、top は上面、w は横幅）。台は床まで伸びる。
  // blocks: 下から順の段。stackOn の台の上に積み、stackX があればその位置に積む。
  // blockH: その面だけの段の高さ（省略時は BLOCK_H）
  // restAtStart: 真なら、積んだ全ボディを最初から眠らせる（叩くまで物理が一切動かない）
  // finale: 真なら最終面。クリア時に花火が上がる
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
    {
      name: '面四　大塔',
      goal: 'lower',
      // 通常の高さ（36）の段を10段積んだ塔。台の上面を 470 まで下げて論理画面に収める：
      // 470 − 36×10 = 110 が塔の天辺、だるまの頭は約 34。
      // 段を薄く（26）して12段にする案は、塔が不安定で弱い一打でも倒れたため採らない。
      // 重い段を下寄りに1つ、滑る段を中ほどに1つ。残りは数の圧で見せる。
      // 最終面（finale）では物理の刻みを半分にして2回進め、叩いた段の摩擦をその一打に限りゼロにする
      // （step() と applyStrike() を参照）。強い一打で最下段を抜いても塔が倒れないようにするため。
      platforms: [{ x: 480, top: 470, w: 160 }],
      stackOn: 0,
      blocks: ['normal', 'normal', 'heavy', 'normal', 'normal', 'normal', 'slippery', 'normal', 'normal', 'normal'],
      target: 0,
      restAtStart: true,
      finale: true,
    },
  ];

  const GOAL_TEXT = {
    lower: '段を全部抜いて、だるまを台に降ろせ',
    carry: 'だるまを右の台へ運べ',
  };

  // ---- 達磨の目入れ（通しの進行） ---------------------------------------
  // クリア済みの最大の面番号（0〜STAGES.length）を localStorage に保つ。単調に増え、面選択で戻っても減らない。
  // 目の段階：0 = 筆を入れていない、1 = 輪郭、2 = 瞳まで。
  // 面一クリアで向かって左の目に輪郭、面二で左目が完成、面三で右目に輪郭、面四で両目完成。
  const PROGRESS_KEY = 'daruma-shift.cleared';
  let cleared = loadProgress();

  function loadProgress() {
    try {
      const v = parseInt(localStorage.getItem(PROGRESS_KEY), 10);
      return Number.isFinite(v) ? Math.max(0, Math.min(STAGES.length, v)) : 0;
    } catch (e) {
      return 0;
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(PROGRESS_KEY, String(cleared));
    } catch (e) {
      // 保存できない環境（プライベートモード等）では、その場の進行だけで続ける
    }
  }

  function eyeStages(level) {
    return { left: Math.max(0, Math.min(2, level)), right: Math.max(0, Math.min(2, level - 2)) };
  }

  // 進行の段階 lv（1〜4）で足される筆：どちらの目の、輪郭(1)か瞳(2)か
  function strokeOf(lv) {
    return { side: lv <= 2 ? 'left' : 'right', stage: ((lv - 1) % 2) + 1 };
  }

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
    const bh = stage.blockH || BLOCK_H;
    blocks = stage.blocks.map((type, i) => {
      const props = BLOCK_TYPES[type];
      const body = Bodies.rectangle(sx, base.top - bh / 2 - i * bh, BLOCK_W, bh, {
        label: 'block',
        friction: props.friction,
        frictionStatic: props.frictionStatic,
        density: props.density,
        restitution: 0,
      });
      return { body, type, removed: false, index: i, h: bh };
    });

    const stackTop = base.top - stage.blocks.length * bh;
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

    // 最初から眠らせる面：眠っているボディには重力も当たらず、叩いて起こすまで一切動かない。
    // 段をぴったり接して置いてあるので、起きた時点の姿勢は積んだとおり。
    if (stage.restAtStart) for (const body of dynamicBodies()) Sleeping.set(body, true);

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
    if (stage.finale) {
      // 最終面だけ刻みを半分にして2回進める。接触の計算が細かくなり、抜いた段の落下がまっすぐになる。
      // 全画面に広げると面一のパワー0.5の挙動が変わる（段が抜けて塔が倒れる）ため、ここに限定する。
      Engine.update(engine, STEP_MS / 2);
      Engine.update(engine, STEP_MS / 2);
    } else {
      Engine.update(engine, STEP_MS);
    }
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
    // 目入れの進行：初めて到達した面なら進め、足された筆を演出で見せる
    const n = stageIndex + 1;
    if (n > cleared) {
      const prev = cleared;
      cleared = n;
      saveProgress();
      fx.onEyeInk(prev, n);
    }
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
    if (stage.finale) {
      // 最終面だけ、叩いた段の摩擦をこの一打に限りゼロにする。本物のだるまおとしで、木槌の一撃では
      // 段が摩擦で上の段を引きずる前に抜け飛ぶ挙動に寄せる。他の面では触らない。
      b.body.friction = 0;
      b.body.frictionStatic = 0;
    }
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
    const bh = b.h;
    const hw = BLOCK_W / 2;
    const hh = bh / 2;

    const hovered = aim && aim.block === b;
    roundRectPath(ctx, -hw, -hh, BLOCK_W, bh, BLOCK_CORNER);
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
    roundRectPath(ctx, -hw, -hh, BLOCK_W, bh, BLOCK_CORNER);
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
    // 目の画素を消した複製があればそれを、なければ元の絵を描いて目の上に顔色の楕円を重ねる
    ctx.drawImage(darumaSprite || img, dx, dy, dw, dh);
    const eyes = darumaEyes.map((e) => ({
      x: dx + e.x * scale,
      y: dy + e.y * scale,
      r: e.r * scale,
      mx: (e.rx + 1) * scale,
      my: (e.ry + 1) * scale,
    }));
    drawEyeInk(ctx, eyes, !darumaSprite, darumaFaceColor);
    ctx.restore();
  }

  // 目入れの描画。eyes はだるまの座標系（外形の中心が原点）での [向かって左, 向かって右]。
  // x, y は目の中心、r は瞳の半径、mx, my は元の目を隠す楕円の半径。
  // 段階は保存された進行（cleared）から、足されたばかりの筆は fx の進みに合わせて途中まで描く。
  function drawEyeInk(ctx, eyes, mask, faceColor) {
    const st = eyeStages(cleared);
    const sides = ['left', 'right'];
    for (let i = 0; i < 2; i++) {
      const e = eyes[i];
      if (mask) {
        ctx.fillStyle = faceColor;
        ctx.beginPath();
        ctx.ellipse(e.x, e.y, e.mx, e.my, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      const target = st[sides[i]];
      const lw = Math.max(1.2, e.r * 0.28);
      if (target >= 1) {
        // 輪郭：上から時計回りに筆を回す
        const p = fx.inkProgress(sides[i], 1);
        if (p > 0) {
          ctx.strokeStyle = INK;
          ctx.lineWidth = lw;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
          ctx.stroke();
        }
      }
      if (target >= 2) {
        // 瞳：中心から墨の点がスッと広がる（わずかに行き過ぎて戻る）
        const p = fx.inkProgress(sides[i], 2);
        if (p > 0) {
          const q = p - 1;
          const k = Math.max(0, 1 + 2.7 * q * q * q + 1.7 * q * q);
          ctx.fillStyle = INK;
          ctx.beginPath();
          ctx.arc(e.x, e.y, (e.r + lw / 2) * k, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
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

    // 目（目入れの進行に従う。仮描画には元の目が無いので隠す楕円は要らない）
    drawEyeInk(
      ctx,
      [
        { x: -12, y: -3, r: 4.2, mx: 0, my: 0 },
        { x: 12, y: -3, r: 4.2, mx: 0, my: 0 },
      ],
      false,
      null
    );

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
      // 目入れ：筆が紙を擦る短い音（静かに）
      ink() {
        if (!live()) return;
        const t = ac.currentTime;
        hiss(t, 0.12, 0.08, 'bandpass', 1800, 1.2);
        hiss(t + 0.02, 0.16, 0.06, 'bandpass', 700, 1.5);
      },
      // 花火の打ち上げ：細く上がる笛
      whistle() {
        if (!live()) return;
        tone(500, 1400, ac.currentTime, 0.42, 0.045, 'sine');
      },
      // 花火の開く音：腹に響く低い破裂と、あとに続くパチパチ
      boom(i) {
        if (!live()) return;
        const t = ac.currentTime;
        const f = 70 + (i % 3) * 8;
        tone(f, 32, t, 0.7, 0.9, 'sine');
        hiss(t, 0.3, 0.55, 'lowpass', 240, 0.8);
        hiss(t, 0.06, 0.3, 'bandpass', 900, 0.9);
        for (let k = 0; k < 7; k++) hiss(t + 0.15 + k * 0.07 + Math.random() * 0.04, 0.025, 0.1, 'highpass', 2600, 1);
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
    const inks = []; // 足されたばかりの筆 { side, stage, delay, dur, age, sounded }
    const shells = []; // 花火の玉（打ち上げ中） { at, x, y, color, rise, age, launched, px, py, t }
    const bursts = []; // 開いた火花
    let boomCount = 0;
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
      inks.length = 0;
      shells.length = 0;
      bursts.length = 0;
      boomCount = 0;
      Object.assign(cam, { z: 1, target: 1, holdMs: 0, fx: W / 2, fy: H / 2, cx: W / 2, cy: H / 2 });
    }

    // 最終面の花火：約2秒の間に6発。朱・金・白・藍の順で、画面の上の方に散らして開く
    function spawnFireworks() {
      const plan = [
        { at: 200, x: 300, y: 150, color: WA.shu },
        { at: 600, x: 680, y: 120, color: WA.kin },
        { at: 950, x: 470, y: 90, color: WA.shiro },
        { at: 1300, x: 200, y: 170, color: WA.ai },
        { at: 1650, x: 760, y: 150, color: WA.shu },
        { at: 2000, x: 500, y: 125, color: WA.kin },
      ];
      for (const s of plan) {
        shells.push({ ...s, rise: 420 + Math.random() * 120, age: 0, launched: false, px: s.x, py: H + 10, t: 0 });
      }
    }

    // 玉が開く：外の輪（円形に均等）と、内の小さな輪（白）
    function burst(s) {
      const outer = 46;
      for (let i = 0; i < outer; i++) {
        const ang = (i / outer) * Math.PI * 2 + (Math.random() - 0.5) * 0.08;
        const sp = 0.17 + Math.random() * 0.03;
        bursts.push({
          x: s.x,
          y: s.y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          life: 850 + Math.random() * 350,
          age: 0,
          color: s.color,
          size: 1.6 + Math.random() * 1.2,
          ph: Math.random() * Math.PI * 2,
        });
      }
      const inner = 18;
      for (let i = 0; i < inner; i++) {
        const ang = (i / inner) * Math.PI * 2 + 0.17;
        const sp = 0.085 + Math.random() * 0.02;
        bursts.push({
          x: s.x,
          y: s.y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          life: 700 + Math.random() * 250,
          age: 0,
          color: s.color === WA.shiro ? WA.kin : WA.shiro,
          size: 1.2 + Math.random() * 0.8,
          ph: Math.random() * Math.PI * 2,
        });
      }
      bursts.push({ x: s.x, y: s.y, vx: 0, vy: 0, life: 170, age: 0, flash: true });
      sound.boom(boomCount++);
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
        spawnSparks(b.body.position.x - (dir.x * BLOCK_W) / 2, b.body.position.y - (dir.y * b.h) / 2, dir, p);
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
        if (stage.finale) spawnFireworks();
      },

      // 目入れの進行が from から to へ進んだ。足された筆を順に、少し間を置いて入れる
      onEyeInk(from, to) {
        for (let lv = from + 1, k = 0; lv <= to; lv++, k++) {
          const s = strokeOf(lv);
          inks.push({ side: s.side, stage: s.stage, delay: 320 + k * 380, dur: 420, age: 0, sounded: false });
        }
      },

      // その筆の進み（0〜1）。いま足している最中でなければ 1（描き終わっている）
      inkProgress(side, stageNo) {
        for (const a of inks) {
          if (a.side === side && a.stage === stageNo) return Math.max(0, Math.min(1, (a.age - a.delay) / a.dur));
        }
        return 1;
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

        // 目入れの筆
        for (const a of inks) {
          a.age += dt;
          if (!a.sounded && a.age >= a.delay) {
            a.sounded = true;
            sound.ink();
          }
        }

        // 花火：打ち上げ（下端から開く位置まで、減速しながら上がる）→ 開く
        for (let i = shells.length - 1; i >= 0; i--) {
          const s = shells[i];
          s.age += dt;
          if (s.age < s.at) continue;
          if (!s.launched) {
            s.launched = true;
            sound.whistle();
          }
          const t = (s.age - s.at) / s.rise;
          if (t >= 1) {
            burst(s);
            shells.splice(i, 1);
            continue;
          }
          const k = 1 - (1 - t) * (1 - t);
          s.t = t;
          s.py = H + 10 - (H + 10 - s.y) * k;
          s.px = s.x + Math.sin(t * 9) * 4 * (1 - t);
        }
        for (let i = bursts.length - 1; i >= 0; i--) {
          const b = bursts[i];
          b.age += dt;
          if (b.age >= b.life) {
            bursts.splice(i, 1);
            continue;
          }
          if (b.flash) continue;
          const drag = Math.exp(-dt / 900);
          b.vx *= drag;
          b.vy *= drag;
          b.vy += 0.00022 * dt;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
        }
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

        // 花火（最終面のクリアだけ。画面に固定して、空の遠景として描く）
        if (shells.length || bursts.length) {
          ctx.save();
          ctx.lineCap = 'round';
          for (const s of shells) {
            if (!s.launched) continue;
            // 上がる玉：金の点と、下へ伸びる薄い尾
            ctx.globalAlpha = 1;
            ctx.strokeStyle = 'rgba(42,37,34,0.3)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(s.px, s.py);
            ctx.lineTo(s.px, s.py + 26 * (1 - s.t) + 6);
            ctx.stroke();
            ctx.fillStyle = WA.kin;
            ctx.beginPath();
            ctx.arc(s.px, s.py, 2.4, 0, Math.PI * 2);
            ctx.fill();
          }
          for (const b of bursts) {
            const k = 1 - b.age / b.life;
            if (b.flash) {
              // 開いた瞬間の閃き
              ctx.globalAlpha = k * 0.9;
              ctx.fillStyle = '#ffffff';
              ctx.strokeStyle = WA.kin;
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(b.x, b.y, 10 + 34 * (1 - k), 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
              continue;
            }
            // 終わり際は瞬きながら消える。白と金は紙に溶けるので薄い墨の縁を下に敷く
            const twinkle = k < 0.45 ? 0.55 + 0.45 * Math.sin(b.age * 0.045 + b.ph) : 1;
            ctx.globalAlpha = Math.min(1, k * 2.2) * twinkle;
            const tx = b.x - b.vx * 14;
            const ty = b.y - b.vy * 14;
            ctx.strokeStyle = 'rgba(42,37,34,0.35)';
            ctx.lineWidth = b.size + 1.6;
            ctx.beginPath();
            ctx.moveTo(b.x, b.y);
            ctx.lineTo(tx, ty);
            ctx.stroke();
            ctx.strokeStyle = b.color;
            ctx.lineWidth = b.size;
            ctx.stroke();
          }
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
      // 失敗表示は少しだけ間を置いて、落ちる様子を見せる。クリアは筆文字と寄りを先に見せる。
      // 最終面は花火が上がり切るまで待つ
      const wait = r === 'clear' ? (stage.finale ? 2800 : 900) : 700;
      setTimeout(() => {
        if (result === r) resultEl.hidden = false;
      }, wait);
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
        cleared,
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
    // 目入れの進行。引数なしで読む。n を渡すとクリア済みの最大面を n に置き換えて保存する（確認用）
    progress(n) {
      if (n != null) {
        cleared = Math.max(0, Math.min(STAGES.length, Math.floor(n)));
        saveProgress();
      }
      return { cleared, eyes: eyeStages(cleared), eyePixels: darumaEyes.map((e) => ({ x: e.x, y: e.y, rx: e.rx, ry: e.ry, r: e.r })), eyesDetected: !!darumaSprite };
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
