// オラオラだるまおとし（融合試作）
// 主観視点のターン制。段の塔の上に乗った敵だるまが飛来物を投げ、それが途中で止まる。
// 時間停止の間に「飛来物の迎撃」と「段を殴る」を予約し、まとめて再生する。
// 段の動きは離散モデル（1目＝段の幅の3分の1）。物理エンジンは使わない。
// 素の Canvas 2D と WebAudio だけで書く。論理画面は 960×540。
(function () {
  'use strict';

  // ---- 調整値 ----
  const W = 960;
  const H = 540;
  const TIMESTOP_MS = 4000; // 時間停止フェイズの長さ（実時間）
  const PUNCH_INTERVAL_MS = 60; // 再生フェイズで拳を繰り出す間隔
  const SEGMENT_COUNT = 5; // 段の数
  const NOTCHES_TO_REMOVE = 3; // ずれの絶対値がこの目に達したら段が抜ける
  const TOPPLE_LIMIT = 1.5; // 境目より上の塊の重心が、支えの中心からこの目を超えて外れたら転倒
  const SHAKE_LIMIT = NOTCHES_TO_REMOVE - 1; // 揺さぶりだけではこの目までしかずれない（抜けない）
  // 飛来物の数 = min(PROJ_MAX, PROJ_BASE + PROJ_PER_REMOVED×抜いた段 + floor((ターン−1) / PROJ_TURNS_PER_STEP))
  const PROJ_BASE = 1;
  const PROJ_PER_REMOVED = 1;
  const PROJ_TURNS_PER_STEP = 5;
  const PROJ_MAX = 9;

  const SEG_W = 300; // 段の幅
  const SEG_H = 34; // 段の高さ
  const NOTCH_PX = SEG_W / 3; // 1目の画素数（100）
  const TABLE_Y = 470; // 台の上面
  const TABLE_W = 340; // 台の幅
  const CENTER_X = 480; // 塔の中心（ずれ 0 の位置）
  const DARUMA_W = 150; // 敵だるまの絵の幅（透明部分を除いた絵の幅）
  const SEG_COLORS = ['#d9482b', '#2e4a7a', '#d9a83a', '#4e7d4a', '#7a4a6e', '#b07040', '#5a8a8a'];

  const ATTACK_MS = 750; // 飛来物が塔から出て止まるまでの時間
  const FREEZE_Z = 0.6; // 時間停止時の奥行き（0 = 投げ手の位置、1 = プレイヤーの顔）
  const ADVANCE_Z = 0.85; // 再生中に迎撃されなかった飛来物が近づく奥行き
  const IMPACT_STAGGER_MS = 170; // 被弾の間隔
  const IMPACT_MS = 220; // 被弾ひとつの飛び込み時間
  const BETWEEN_MS = 650; // ターンの間の息つぎ
  const WARN_MS = 1000; // 残りこの時間を切ると表示色が変わる
  const TOPPLE_MS = 1300; // 転倒がこちらへ倒れ切るまで
  const RESULT_DELAY_MS = 1500; // 決着から結果の箱を出すまで（負けは転倒の後に足す）
  const CRACK_REF_W = 380; // ヒビの大きさの基準（ora の敵だるまの幅）

  const PLAYER_W = 90; // 自だるまの絵の幅
  const PLAYER_CX = 74;
  const PLAYER_CY = 470;
  const FIST_REST = [
    { x: 300, y: 530 },
    { x: 660, y: 530 },
  ];
  const FIST_W = 120;

  const PAPER = '#f3ead8';
  const WALL = '#e9dcc1';
  const FLOOR = '#c9b58f';
  const MINCHO = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
  const WA = { shu: '#d9482b', kin: '#d9a83a', shiro: '#fbf6ea', ai: '#2e4a7a', sumi: '#2a2522' };
  const TAU = Math.PI * 2;

  // ---- 決定的な乱数（同じクリック列 → 同じ結果にするため、ゲームの論理は全部これを使う） ----
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash3(a, b, c) {
    let h = 2166136261;
    for (const v of [a, b, c]) {
      h ^= (v | 0) + 0x9e3779b9;
      h = Math.imul(h, 16777619);
      h ^= h >>> 13;
    }
    return h >>> 0;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - (1 - t) * (1 - t);
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

  // ---- だるまの素材 ----
  const darumaImage = new Image();
  let imageReady = false;
  let imageFailed = false;
  let px = null; // 画素（読めたときだけ。file:// では canvas が汚染されて読めない）
  let artBox = { x: 8, y: 5, w: 80, h: 86 }; // 透明部分を除いた絵の範囲（画素が読めなければこの近似値）
  darumaImage.onload = function () {
    try {
      const c = document.createElement('canvas');
      c.width = darumaImage.naturalWidth;
      c.height = darumaImage.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(darumaImage, 0, 0);
      px = { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
      let minX = px.w, minY = px.h, maxX = -1, maxY = -1;
      for (let y = 0; y < px.h; y++) {
        for (let x = 0; x < px.w; x++) {
          if (px.data[(y * px.w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX >= 0) artBox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    } catch (e) {
      px = null;
    }
    imageReady = true;
    enemyView.dirty = true;
    playerView.dirty = true;
  };
  darumaImage.onerror = function () {
    imageFailed = true;
    enemyView.dirty = true;
    playerView.dirty = true;
  };
  darumaImage.src = '../assets/daruma.png';

  // ---- だるまの見た目（絵＋ヒビ＋欠け）。絵の中心を原点にした論理座標で扱う ----
  // ヒビは絵の不透明部分にだけ乗せ（source-atop）、欠けは画素を消して背景を見せる（destination-out）。
  function makeDarumaView(artW) {
    const view = {
      canvas: document.createElement('canvas'),
      k: 0,
      dirty: true,
      cracks: [],
      stage: 0,
      artW,
      geom() {
        const s = artW / artBox.w;
        const iw = imageFailed || !imageReady ? 96 : darumaImage.naturalWidth;
        const ih = imageFailed || !imageReady ? 96 : darumaImage.naturalHeight;
        return {
          s,
          w: iw * s,
          h: ih * s,
          artH: artBox.h * s,
          ox: -(artBox.x + artBox.w / 2) * s, // 画像の左上の、絵の中心からの位置
          oy: -(artBox.y + artBox.h / 2) * s,
        };
      },
      // 絵の中心からの相対座標が絵の中か
      inside(rx, ry) {
        const g = this.geom();
        if (px && !imageFailed) {
          const ix = Math.floor((rx - g.ox) / g.s);
          const iy = Math.floor((ry - g.oy) / g.s);
          if (ix < 0 || iy < 0 || ix >= px.w || iy >= px.h) return false;
          return px.data[(iy * px.w + ix) * 4 + 3] > 8;
        }
        const a = rx / (artW / 2);
        const b = ry / (g.artH / 2);
        return a * a + b * b <= 1;
      },
      // 中心から角度 a の方向へ進んで、絵の縁に出る点
      edge(a) {
        const g = this.geom();
        const max = Math.max(artW, g.artH);
        let last = { x: 0, y: 0 };
        for (let r = 0; r <= max; r += 2) {
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r;
          if (!this.inside(x, y)) return last;
          last = { x, y };
        }
        return last;
      },
      rebuild(k) {
        const g = this.geom();
        const c = this.canvas;
        c.width = Math.max(1, Math.ceil(g.w * k));
        c.height = Math.max(1, Math.ceil(g.h * k));
        const ctx = c.getContext('2d');
        ctx.setTransform(k, 0, 0, k, 0, 0);
        ctx.imageSmoothingEnabled = false; // ドット絵をくっきり見せる
        if (imageReady && !imageFailed) {
          ctx.drawImage(darumaImage, 0, 0, g.w, g.h);
        } else {
          drawProceduralDaruma(ctx, g);
        }
        ctx.translate(-g.ox, -g.oy);
        const stage = this.stage;
        const scale = artW / CRACK_REF_W;
        // 段階：0 = 打痕（薄く短い）、1 = 小ヒビ、2 = 大きなヒビ＋縁の欠け
        const lenMul = [0.3, 0.75, 1.3][stage];
        const lw = [1.3, 2.2, 3.4][stage] * Math.max(0.45, scale);
        const alpha = [0.55, 0.9, 1][stage];
        ctx.globalCompositeOperation = 'source-atop';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const cr of this.cracks) {
          for (const br of cr.branches) {
            ctx.beginPath();
            ctx.moveTo(cr.x, cr.y);
            for (const p of br) ctx.lineTo(cr.x + p.x * lenMul, cr.y + p.y * lenMul);
            ctx.strokeStyle = `rgba(36, 22, 16, ${alpha})`;
            ctx.lineWidth = lw;
            ctx.stroke();
            // 片側に明るい線を添えて割れ目に見せる
            ctx.beginPath();
            ctx.moveTo(cr.x - 0.9, cr.y - 0.9);
            for (const p of br) ctx.lineTo(cr.x + p.x * lenMul - 0.9, cr.y + p.y * lenMul - 0.9);
            ctx.strokeStyle = `rgba(255, 244, 226, ${0.45 * alpha})`;
            ctx.lineWidth = lw * 0.4;
            ctx.stroke();
          }
        }
        if (stage >= 2) {
          ctx.globalCompositeOperation = 'destination-out';
          for (const cr of this.cracks) {
            if (!cr.chip) continue;
            ctx.beginPath();
            cr.chip.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.closePath();
            ctx.fill();
          }
        }
        ctx.globalCompositeOperation = 'source-over';
        this.k = k;
        this.dirty = false;
      },
      draw(ctx, k, cx, cy) {
        if (this.dirty || this.k !== k) this.rebuild(k);
        const g = this.geom();
        ctx.drawImage(this.canvas, cx + g.ox, cy + g.oy, g.w, g.h);
      },
    };
    return view;
  }

  // 素材が読めないときの仮のだるま（画像と同じ 96×96 の枠に描く）
  function drawProceduralDaruma(ctx, g) {
    const s = g.s;
    ctx.save();
    ctx.scale(s, s);
    ctx.fillStyle = '#c8311c';
    ctx.beginPath();
    ctx.ellipse(48, 50, 40, 44, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fffcf5';
    ctx.beginPath();
    ctx.ellipse(48, 52, 26, 24, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#2a2522';
    ctx.beginPath();
    ctx.ellipse(37, 46, 6, 7, 0, 0, TAU);
    ctx.ellipse(59, 46, 6, 7, 0, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2a2522';
    ctx.beginPath();
    ctx.moveTo(40, 66);
    ctx.lineTo(56, 66);
    ctx.stroke();
    ctx.restore();
  }

  // 打点（絵の中心からの相対座標）と何打目かから、ヒビの形を決定的に作る
  function generateCrack(view, rx, ry, n) {
    const rng = mulberry32(hash3(Math.round(rx), Math.round(ry), n));
    const scale = view.artW / CRACK_REF_W;
    const branches = [];
    const nb = 2 + Math.floor(rng() * 3);
    const a0 = rng() * TAU;
    for (let b = 0; b < nb; b++) {
      let a = a0 + (b * TAU) / nb + (rng() - 0.5) * 0.8;
      const total = (28 + rng() * 36) * scale;
      const segs = 3 + Math.floor(rng() * 3);
      let x = 0;
      let y = 0;
      const pts = [];
      for (let s = 0; s < segs; s++) {
        a += (rng() - 0.5) * 1.1;
        const step = (total / segs) * (0.7 + 0.6 * rng());
        x += Math.cos(a) * step;
        y += Math.sin(a) * step;
        pts.push({ x, y });
      }
      branches.push(pts);
    }
    let chip = null;
    if (n % 2 === 0) {
      const dir = Math.hypot(rx, ry) > 8 * scale ? Math.atan2(ry, rx) : n * 2.399;
      const e = view.edge(dir);
      const r = (10 + rng() * 14) * scale;
      chip = [];
      for (let i = 0; i < 6; i++) {
        const a = (i * TAU) / 6 + (rng() - 0.5) * 0.5;
        const rr = r * (0.6 + 0.6 * rng());
        chip.push({ x: e.x + Math.cos(a) * rr, y: e.y + Math.sin(a) * rr });
      }
    }
    return { x: rx, y: ry, n, branches, chip };
  }

  const enemyView = makeDarumaView(DARUMA_W);
  const playerView = makeDarumaView(PLAYER_W);

  // ---- 音（WebAudio 合成。和風の打楽器寄り） ----
  const sound = (function () {
    let ac = null;
    let out = null;
    let noise = null;

    function init() {
      if (ac) {
        if (ac.state === 'suspended') ac.resume();
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
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
    const YO = [0, 2, 5, 7, 9]; // 陽音階
    function scaleNote(i) {
      const semi = 12 * Math.floor(i / 5) + YO[i % 5];
      return 293.66 * Math.pow(2, semi / 12);
    }
    function wood(i, vol, at) {
      const f = scaleNote(i);
      tone(f, f * 0.97, at, 0.18, 0.32 * vol, 'triangle');
      tone(f * 2.4, f * 2.3, at, 0.05, 0.1 * vol, 'sine');
      hiss(at, 0.02, 0.18 * vol, 'bandpass', f * 4, 2);
    }

    return {
      init,
      // 拳の打撃。p = 再生の進み（0→1）で音程が上がる
      punch(p) {
        if (!live()) return;
        const t = ac.currentTime;
        const f = 200 + 320 * p;
        hiss(t, 0.05, 0.45, 'bandpass', 1100 + 1500 * p, 1.3);
        tone(f, f * 0.55, t, 0.1, 0.5, 'triangle');
        tone(120, 60, t, 0.09, 0.35, 'sine');
      },
      // 飛来物の破砕：木はカラッと、岩はザクッと
      shatter(kind, p) {
        if (!live()) return;
        const t = ac.currentTime;
        if (kind === 'wood') {
          wood(4 + Math.floor(p * 5), 0.7, t);
          wood(7 + Math.floor(p * 4), 0.4, t + 0.03);
          hiss(t, 0.06, 0.3, 'highpass', 2500, 1);
        } else {
          hiss(t, 0.12, 0.6, 'lowpass', 500, 0.8);
          hiss(t, 0.05, 0.35, 'bandpass', 1800, 1.5);
          tone(160, 70, t, 0.12, 0.3, 'triangle');
        }
      },
      // 段が抜ける：太い木の音と、上が落ちて乗る音
      knock() {
        if (!live()) return;
        const t = ac.currentTime;
        tone(150, 62, t, 0.26, 0.85, 'triangle');
        hiss(t, 0.09, 0.55, 'lowpass', 650, 0.8);
        wood(2, 1, t + 0.02);
        wood(0, 0.8, t + 0.07);
        tone(100, 50, t + 0.14, 0.16, 0.45, 'sine');
        hiss(t + 0.14, 0.05, 0.3, 'lowpass', 400, 0.8);
      },
      // 揺さぶりで段が滑る
      slide() {
        if (!live()) return;
        const t = ac.currentTime;
        hiss(t, 0.14, 0.35, 'bandpass', 700, 0.9);
        tone(130, 90, t, 0.14, 0.3, 'triangle');
      },
      // 予約の印を付ける小さな音
      mark() {
        if (!live()) return;
        const t = ac.currentTime;
        tone(1400, 1200, t, 0.05, 0.12, 'sine');
        hiss(t, 0.02, 0.12, 'bandpass', 3000, 2);
      },
      // 時間停止：低いドンのあと、細い余韻だけが残る
      timestop() {
        if (!live()) return;
        const t = ac.currentTime;
        tone(90, 36, t, 0.7, 0.9, 'sine');
        hiss(t, 0.08, 0.3, 'lowpass', 300, 0.7);
        tone(2400, 1900, t + 0.05, 1.2, 0.04, 'sine');
      },
      // 残り 1 秒の合図
      warn() {
        if (!live()) return;
        const t = ac.currentTime;
        tone(900, 880, t, 0.08, 0.18, 'square');
        tone(900, 880, t + 0.12, 0.08, 0.18, 'square');
      },
      // 被弾
      hurt() {
        if (!live()) return;
        const t = ac.currentTime;
        tone(150, 55, t, 0.28, 0.6, 'triangle');
        hiss(t, 0.1, 0.5, 'lowpass', 700, 0.8);
        hiss(t, 0.04, 0.3, 'bandpass', 1500, 1);
      },
      // 勝ち：太鼓の一打と木の音の上昇
      burst() {
        if (!live()) return;
        const t = ac.currentTime;
        tone(95, 48, t, 0.55, 0.9, 'sine');
        hiss(t, 0.1, 0.35, 'lowpass', 350, 0.7);
        hiss(t, 0.25, 0.5, 'bandpass', 900, 0.8);
        [5, 6, 7, 9].forEach((n, k) => wood(n, k === 3 ? 1 : 0.8, t + 0.18 + k * 0.085));
      },
      // 転倒のはじまり：きしみと低い揺れ
      topple() {
        if (!live()) return;
        const t = ac.currentTime;
        hiss(t, 0.9, 0.45, 'lowpass', 180, 0.6);
        tone(70, 34, t, 1.0, 0.6, 'sine');
        [4, 3, 1, 0].forEach((n, k) => wood(n, 0.5, t + 0.1 + k * 0.16));
      },
      // 転倒の着地
      fail() {
        if (!live()) return;
        const t = ac.currentTime;
        tone(120, 72, t, 0.4, 0.45, 'triangle');
        tone(80, 40, t + 0.1, 0.6, 0.6, 'sine');
        hiss(t, 0.3, 0.4, 'lowpass', 400, 0.8);
      },
      whistle() {
        if (!live()) return;
        tone(500, 1400, ac.currentTime, 0.42, 0.045, 'sine');
      },
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

  // ---- ゲームの状態 ----
  let phase = 'title'; // title | attack | timestop | replay | impact | between | win | lose
  let turn = 0;
  let segments = []; // 残っている段、下から順 { id, offset, color, hitThisTurn, dispDx, dispDy }
  let darumaOffset = 0; // 敵だるまのずれ（目）
  let removed = 0; // 抜いた段の数
  let leaks = 0; // 累計の漏れ数
  let cracks = 0; // 自だるまのヒビ数（見た目だけのカウンター）
  let projectiles = [];
  let queue = []; // 予約した拳 { type: 'proj', id, hand } | { type: 'seg', id, d, hand }
  let marks = []; // 時間停止中に付けた印 { x, y, label, kind }
  let nextProjId = 1;
  let topple = null; // 転倒 { k: 境目（-1 = 台と一番下の段）, dir, landed }
  let finalDarumaOffset = 0; // 転倒・勝ちの時点のだるまのずれ（結果の文に使う）

  let phaseTimer = 0; // フェイズ内の経過（ms、描画のクロックで進める）
  let stopStart = 0; // 時間停止の開始時刻（performance.now）
  let warned = false;
  let replayIdx = 0;
  let replayDuration = 0;
  let replayTotal = 0;
  let resultShown = false;

  // 演出
  let clock = 0; // 全フェイズで進む描画用の時計
  const daruma = { dispDx: 0, dispDy: 0, tilt: 0, lunge: 0 }; // 敵だるまの見た目のずれ・傾き・投げの前のめり
  const flying = []; // 抜けて飛んでいく段 { x, y, vx, vy, rot, vr, color, age }
  const lastPunch = [null, null]; // 手ごとの直近の拳 { tx, ty, start }
  const trails = []; // 残像 { hand, x, y, s, age }
  const impacts = []; // 衝撃 { x, y, age, dur, size, color }
  const shards = []; // 破片 { x, y, vx, vy, rot, vr, age, dur, color, w, h }
  const petals = [];
  const shells = []; // 花火の玉
  const bursts = []; // 開いた花火
  let shakeMs = 0;
  let shakeAmp = 0;
  let shakeX = 0;
  let shakeY = 0;
  let flash = null; // { color, alpha }
  let banner = null; // { text, age, color }
  let playerSquash = 0;
  let boomCount = 0;
  let fireworkTimer = 0;
  let fireworksLeft = 0;

  // ---- 塔の幾何（論理位置。見た目のずれは dispDx/dispDy で別に持つ） ----
  function segTop(i) {
    return TABLE_Y - SEG_H * (i + 1);
  }
  function segRect(i) {
    const s = segments[i];
    return { x: CENTER_X + s.offset * NOTCH_PX - SEG_W / 2, y: segTop(i), w: SEG_W, h: SEG_H };
  }
  function darumaGeom() {
    const g = enemyView.geom();
    const bottom = TABLE_Y - SEG_H * segments.length;
    return { cx: CENTER_X + darumaOffset * NOTCH_PX, cy: bottom - g.artH / 2, bottom, artH: g.artH };
  }
  function darumaRect() {
    const d = darumaGeom();
    return { x: d.cx - DARUMA_W / 2, y: d.bottom - d.artH, w: DARUMA_W, h: d.artH };
  }

  // 安定判定。各境目について、その境目より上の塊（段とだるま、重さ各 1）の重心が
  // 支えている側の中心から TOPPLE_LIMIT 目を超えて外れたら転倒。台のずれは 0。
  // 整数のまま比べる（sum − support×n と TOPPLE_LIMIT×n）ので丸めの影響を受けない。
  function checkStability() {
    for (let k = -1; k < segments.length; k++) {
      const support = k < 0 ? 0 : segments[k].offset;
      let sum = darumaOffset;
      let n = 1;
      for (let j = k + 1; j < segments.length; j++) {
        sum += segments[j].offset;
        n += 1;
      }
      const diff = sum - support * n;
      if (Math.abs(diff) > TOPPLE_LIMIT * n) return { k, dir: diff >= 0 ? 1 : -1 };
    }
    return null;
  }

  // ---- 飛来物 ----
  function projPos(p) {
    return { x: lerp(p.ox, p.dx, p.z), y: lerp(p.oy, p.dy, p.z) };
  }
  function projScale(z) {
    return 0.35 + 1.1 * z;
  }
  function projRadius(p) {
    return (p.kind === 'wood' ? 34 : 30) * projScale(p.z);
  }

  function projectileCount() {
    return Math.min(PROJ_MAX, PROJ_BASE + PROJ_PER_REMOVED * removed + Math.floor((turn - 1) / PROJ_TURNS_PER_STEP));
  }

  // 凍結位置の候補。塔の柱（x 330〜630、y 290〜470）を避けて左右と上に散らす
  function spawnProjectiles() {
    const rng = mulberry32(hash3(turn, removed, 13));
    const slots = [];
    for (const x of [110, 250, 710, 850]) for (const y of [90, 260, 430]) slots.push({ x, y });
    slots.push({ x: 480, y: 60 });
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = slots[i];
      slots[i] = slots[j];
      slots[j] = tmp;
    }
    const k = projectileCount();
    const dg = darumaGeom();
    projectiles = [];
    for (let i = 0; i < k; i++) {
      const s = slots[i];
      const fx = s.x + (rng() - 0.5) * 50;
      const fy = s.y + (rng() - 0.5) * 40;
      // 投げ手は塔の上の敵だるま。凍結位置 (fx, fy) が z = FREEZE_Z に来るように行き先を逆算する
      const ox = dg.cx + (rng() - 0.5) * 60;
      const oy = dg.cy + (rng() - 0.5) * 40;
      projectiles.push({
        id: nextProjId++,
        kind: rng() < 0.6 ? 'wood' : 'rock',
        ox,
        oy,
        dx: ox + (fx - ox) / FREEZE_Z,
        dy: oy + (fy - oy) / FREEZE_Z,
        fx,
        fy,
        z: 0,
        rot: rng() * TAU,
        spin: (rng() - 0.5) * 6,
        marked: false,
        alive: true,
        hitAt: 0,
        hitDone: false,
      });
    }
  }

  // ---- フェイズ遷移 ----
  function startBattle() {
    phase = 'between';
    turn = 0;
    segments = [];
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      segments.push({ id: i + 1, offset: 0, color: SEG_COLORS[i % SEG_COLORS.length], hitThisTurn: false, dispDx: 0, dispDy: 0 });
    }
    darumaOffset = 0;
    removed = 0;
    leaks = 0;
    cracks = 0;
    projectiles = [];
    queue = [];
    marks = [];
    topple = null;
    finalDarumaOffset = 0;
    enemyView.cracks = [];
    enemyView.stage = 0;
    enemyView.dirty = true;
    playerView.cracks = [];
    playerView.stage = 0;
    playerView.dirty = true;
    daruma.dispDx = daruma.dispDy = daruma.tilt = daruma.lunge = 0;
    flying.length = 0;
    trails.length = 0;
    impacts.length = 0;
    shards.length = 0;
    petals.length = 0;
    shells.length = 0;
    bursts.length = 0;
    lastPunch[0] = lastPunch[1] = null;
    shakeMs = shakeAmp = 0;
    flash = null;
    banner = null;
    playerSquash = 0;
    boomCount = 0;
    fireworksLeft = 0;
    resultShown = false;
    phaseTimer = BETWEEN_MS - 200;
    ui.showTitle(false);
    ui.showResult(false);
    ui.showGo(false);
  }

  function startAttack() {
    turn += 1;
    phase = 'attack';
    phaseTimer = 0;
    queue = [];
    marks = [];
    for (const s of segments) s.hitThisTurn = false;
    spawnProjectiles();
    daruma.lunge = 1;
  }

  function startTimestop() {
    phase = 'timestop';
    stopStart = performance.now();
    warned = false;
    for (const p of projectiles) p.z = FREEZE_Z;
    sound.timestop();
    ui.showGo(true);
  }

  function beginReplay() {
    if (phase !== 'timestop') return;
    phase = 'replay';
    ui.showGo(false);
    phaseTimer = 0;
    replayIdx = 0;
    replayTotal = queue.length;
    replayDuration = Math.max(450, queue.length * PUNCH_INTERVAL_MS + 320);
  }

  function executePunch(i) {
    const q = queue[i];
    const p = replayTotal > 1 ? i / (replayTotal - 1) : 0;
    if (q.type === 'proj') {
      const pr = projectiles.find((e) => e.id === q.id);
      if (!pr || !pr.alive) return;
      const pos = projPos(pr);
      lastPunch[q.hand] = { tx: pos.x, ty: pos.y, start: clock };
      pr.alive = false;
      spawnShards(pos.x, pos.y, pr.kind === 'wood' ? ['#8a5a2b', '#a9743d', '#5e3b1a'] : ['#7d7a74', '#9b978f', '#55524c'], 10, projRadius(pr));
      impacts.push({ x: pos.x, y: pos.y, age: 0, dur: 200, size: 26 * projScale(pr.z), color: WA.kin });
      sound.punch(p);
      sound.shatter(pr.kind, p);
      return;
    }
    const seg = segments.find((s) => s.id === q.id);
    if (!seg) return; // 同じ再生の中で先に抜けた段。拳は出さない
    punchSegment(seg, q.d, q.hand, p);
  }

  // 段 seg を方向 d（右 +1、左 −1）へ殴る。
  // そのターン初めての段なら、上の段すべてとだるまも同じ方向へ 1 目ついてくる（静止摩擦の引きずり）。
  function punchSegment(seg, d, hand, p) {
    const idx = segments.indexOf(seg);
    const r = segRect(idx);
    const first = !seg.hitThisTurn;
    seg.hitThisTurn = true;
    // 拳の着弾点：殴った側の端
    const tx = d > 0 ? r.x + 26 : r.x + r.w - 26;
    const ty = r.y + r.h / 2;
    lastPunch[hand] = { tx, ty, start: clock };

    seg.offset += d;
    seg.dispDx -= d * NOTCH_PX;
    if (first) {
      for (let j = idx + 1; j < segments.length; j++) {
        segments[j].offset += d;
        segments[j].dispDx -= d * NOTCH_PX;
      }
      darumaOffset += d;
      daruma.dispDx -= d * NOTCH_PX;
      daruma.tilt += d * 0.14;
    } else {
      daruma.tilt += d * 0.03;
    }

    impacts.push({ x: tx, y: ty, age: 0, dur: 220, size: 30, color: WA.shu });
    spawnSparks(tx, ty, 6);
    shake(90, 3 + 3 * p);
    sound.punch(p);

    if (Math.abs(seg.offset) >= NOTCHES_TO_REMOVE) removeSegment(idx, d);
    const top = checkStability();
    if (top) {
      startTopple(top);
      return;
    }
    if (!segments.length) startWin();
  }

  // 段 idx が抜け飛ぶ。上の段とだるまは一段分下がる（ずれの値はそのまま）
  function removeSegment(idx, d) {
    const seg = segments[idx];
    const r = segRect(idx);
    segments.splice(idx, 1);
    removed += 1;
    flying.push({
      x: r.x + r.w / 2 + seg.dispDx,
      y: r.y + r.h / 2 + seg.dispDy,
      vx: d * 24,
      vy: -7,
      rot: 0,
      vr: d * 0.11,
      color: seg.color,
      age: 0,
    });
    for (let j = idx; j < segments.length; j++) segments[j].dispDy -= SEG_H;
    daruma.dispDy -= SEG_H;
    daruma.tilt += (d > 0 ? -1 : 1) * 0.08;
    impacts.push({ x: d > 0 ? r.x + r.w - 20 : r.x + 20, y: r.y + r.h / 2, age: 0, dur: 320, size: 54, color: WA.kin });
    spawnSparks(r.x + r.w / 2, r.y + r.h / 2, 10);
    shake(160, 6);
    sound.knock();
  }

  function beginImpact() {
    const left = projectiles.filter((p) => p.alive && !p.marked);
    if (!left.length) {
      endTurn();
      return;
    }
    phase = 'impact';
    phaseTimer = 0;
    left.forEach((p, i) => {
      p.hitAt = i * IMPACT_STAGGER_MS;
      p.hitDone = false;
    });
  }

  // 漏らした飛来物が自分に当たる：ヒビ（見た目だけ）＋塔の揺さぶり
  function takeHit(p) {
    p.hitDone = true;
    leaks += 1;
    cracks += 1;
    const rng = mulberry32(hash3(cracks, 31, 7));
    const a = rng() * TAU;
    const r = 8 + rng() * 22; // 自だるまの半径 45 の内側
    playerView.cracks.push(generateCrack(playerView, Math.cos(a) * r, Math.sin(a) * r, cracks));
    playerView.stage = Math.min(2, Math.floor(cracks / 3));
    playerView.dirty = true;
    playerSquash = 0.2;
    shake(260, 14);
    flash = { color: '217, 72, 43', alpha: 0.55 };
    sound.hurt();
    shakeTower(p.fx);
  }

  // 揺さぶり（決定的）。対象はずれの絶対値が一番大きい段（同点なら一番下）。
  // ずれが 0 でなければその向きへもう 1 目（ただし SHAKE_LIMIT 目で止まり、抜けない）。
  // 全部 0 なら一番下の段が、飛来物の画面位置が中央より左なら右へ、右なら左へ 1 目（中央ちょうどは右へ）。
  // 上の段はついてこない。
  function shakeTower(projX) {
    if (!segments.length) return;
    let target = segments[0];
    for (const s of segments) if (Math.abs(s.offset) > Math.abs(target.offset)) target = s;
    let moved = false;
    if (target.offset !== 0) {
      const sign = target.offset > 0 ? 1 : -1;
      if (Math.abs(target.offset) < SHAKE_LIMIT) {
        target.offset += sign;
        target.dispDx -= sign * NOTCH_PX;
        moved = true;
      }
    } else {
      const dir = projX > CENTER_X ? -1 : 1;
      segments[0].offset += dir;
      segments[0].dispDx -= dir * NOTCH_PX;
      moved = true;
    }
    daruma.tilt += (projX > CENTER_X ? -1 : 1) * 0.06;
    if (moved) sound.slide();
    const top = checkStability();
    if (top) startTopple(top);
  }

  function endTurn() {
    phase = 'between';
    phaseTimer = 0;
    projectiles = [];
  }

  function startWin() {
    phase = 'win';
    phaseTimer = 0;
    finalDarumaOffset = darumaOffset;
    ui.showGo(false);
    for (const p of projectiles) p.alive = false;
    const dg = darumaGeom();
    impacts.push({ x: dg.cx, y: dg.cy, age: 0, dur: 500, size: 110, color: WA.kin });
    shake(220, 7);
    flash = { color: '255, 250, 230', alpha: 0.6 };
    banner = { text: 'お見事', age: 0, color: WA.shu };
    sound.burst();
    fireworksLeft = 4;
    fireworkTimer = 350;
  }

  function startTopple(top) {
    topple = { k: top.k, dir: top.dir, landed: false };
    phase = 'lose';
    phaseTimer = 0;
    finalDarumaOffset = darumaOffset;
    ui.showGo(false);
    for (const p of projectiles) p.alive = false;
    shake(300, 8);
    sound.topple();
  }

  function toppleLand() {
    topple.landed = true;
    shake(500, 22);
    flash = { color: '120, 20, 20', alpha: 0.7 };
    banner = { text: '倒れた', age: 0, color: WA.sumi };
    sound.fail();
  }

  // ---- 入力 ----
  // 時間停止中のクリック。飛来物 → 迎撃の予約、段 → その段を殴る予約（左半分なら右へ、右半分なら左へ）。
  // だるま本体や何もない所は予約しない。実入力とテスト用フックの両方がここを通る
  function handleClick(x, y) {
    if (phase !== 'timestop') return null;
    let best = null;
    let bestScore = 1;
    for (const p of projectiles) {
      if (!p.alive || p.marked) continue;
      const pos = projPos(p);
      const score = Math.hypot(x - pos.x, y - pos.y) / (projRadius(p) + 10);
      if (score <= bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) {
      best.marked = true;
      const pos = projPos(best);
      queue.push({ type: 'proj', id: best.id, hand: pos.x < CENTER_X ? 0 : 1 });
      marks.push({ x: pos.x, y: pos.y, label: String(queue.length), kind: 'proj', r: projRadius(best) });
      sound.mark();
      return 'proj';
    }
    for (let i = segments.length - 1; i >= 0; i--) {
      const r = segRect(i);
      if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue;
      const cx = r.x + r.w / 2;
      const d = x < cx ? 1 : -1; // 左半分を殴ると右へ、右半分を殴ると左へ
      const hand = x < cx ? 0 : 1; // 殴った側の拳
      queue.push({ type: 'seg', id: segments[i].id, d, hand });
      marks.push({ x, y, label: `${queue.length}${d > 0 ? '→' : '←'}`, kind: 'seg' });
      sound.mark();
      return 'seg';
    }
    return null;
  }

  // 段ごとの予約済みのずれの合計（表示用）
  function reservedNet() {
    const net = new Map();
    for (const q of queue) {
      if (q.type !== 'seg') continue;
      net.set(q.id, (net.get(q.id) || 0) + q.d);
    }
    return net;
  }

  // ---- 演出の部品 ----
  function shake(ms, amp) {
    shakeMs = Math.max(shakeMs, ms);
    shakeAmp = Math.max(shakeAmp, amp);
  }
  function spawnShards(x, y, colors, n, size) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = 3 + Math.random() * 9;
      shards.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 4,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 0.6,
        age: 0,
        dur: 700 + Math.random() * 500,
        color: colors[i % colors.length],
        w: size * (0.2 + Math.random() * 0.35),
        h: size * (0.1 + Math.random() * 0.2),
      });
    }
  }
  function spawnSparks(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = 5 + Math.random() * 7;
      shards.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 3,
        rot: a,
        vr: 0,
        age: 0,
        dur: 250 + Math.random() * 200,
        color: Math.random() < 0.5 ? WA.kin : WA.shiro,
        w: 9,
        h: 3,
      });
    }
  }

  function updateFx(dt) {
    for (let i = trails.length - 1; i >= 0; i--) {
      trails[i].age += dt;
      if (trails[i].age > 140) trails.splice(i, 1);
    }
    for (let i = impacts.length - 1; i >= 0; i--) {
      impacts[i].age += dt;
      if (impacts[i].age > impacts[i].dur) impacts.splice(i, 1);
    }
    const f = dt / 16.67;
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      s.age += dt;
      s.x += s.vx * f;
      s.y += s.vy * f;
      s.vy += 0.45 * f;
      s.rot += s.vr * f;
      if (s.age > s.dur || s.y > H + 60) shards.splice(i, 1);
    }
    for (let i = flying.length - 1; i >= 0; i--) {
      const s = flying[i];
      s.age += dt;
      s.x += s.vx * f;
      s.y += s.vy * f;
      s.vy += 0.5 * f;
      s.rot += s.vr * f;
      if (s.age > 2500 || s.x < -SEG_W || s.x > W + SEG_W || s.y > H + SEG_W) flying.splice(i, 1);
    }
    // 段とだるまの見た目のずれは目標位置へ素早く収束する（殴りは速く、落下は少しゆっくり）
    const kx = Math.pow(0.02, dt / 80);
    const ky = Math.pow(0.02, dt / 150);
    for (const s of segments) {
      s.dispDx *= kx;
      s.dispDy *= ky;
    }
    daruma.dispDx *= kx;
    daruma.dispDy *= ky;
    daruma.tilt *= Math.pow(0.01, dt / 420);
    daruma.lunge = Math.max(0, daruma.lunge - dt / 320);
    for (let i = petals.length - 1; i >= 0; i--) {
      const p = petals[i];
      p.age += dt;
      p.x += (p.vx + Math.sin(p.age / 400 + p.rot) * 0.8) * f;
      p.y += p.vy * f;
      p.rot += p.vr * f;
      if (p.y > H + 20) petals.splice(i, 1);
    }
    for (let i = shells.length - 1; i >= 0; i--) {
      const s = shells[i];
      s.t += dt;
      if (s.t >= s.dur) {
        shells.splice(i, 1);
        const parts = [];
        const n = 26;
        for (let j = 0; j < n; j++) parts.push({ a: (j * TAU) / n + Math.random() * 0.2, v: 3.2 + Math.random() * 1.6 });
        bursts.push({ x: s.tx, y: s.ty, parts, age: 0, color: s.color });
        sound.boom(boomCount++);
      }
    }
    for (let i = bursts.length - 1; i >= 0; i--) {
      bursts[i].age += dt;
      if (bursts[i].age > 1300) bursts.splice(i, 1);
    }
    if (shakeMs > 0) {
      shakeMs -= dt;
      const a = shakeAmp * clamp(shakeMs / 200, 0, 1);
      shakeX = (Math.random() - 0.5) * 2 * a;
      shakeY = (Math.random() - 0.5) * 2 * a;
      if (shakeMs <= 0) shakeAmp = shakeX = shakeY = 0;
    }
    if (flash) {
      flash.alpha -= dt / 450;
      if (flash.alpha <= 0) flash = null;
    }
    if (banner) banner.age += dt;
    playerSquash *= Math.pow(0.001, dt / 260);
    // 勝利の花火と花びら
    if (phase === 'win') {
      if (fireworksLeft > 0) {
        fireworkTimer -= dt;
        if (fireworkTimer <= 0) {
          fireworksLeft -= 1;
          fireworkTimer = 420;
          const tx = 140 + Math.random() * 680;
          shells.push({ x: tx + (Math.random() - 0.5) * 120, y: H + 10, tx, ty: 60 + Math.random() * 150, t: 0, dur: 600, color: [WA.shu, WA.kin, '#e38aa0', WA.ai][boomCount % 4] });
          sound.whistle();
        }
      }
      if (phaseTimer < 3500 && Math.random() < dt / 45) {
        petals.push({ x: Math.random() * W, y: -10, vx: (Math.random() - 0.5) * 1.2, vy: 1 + Math.random() * 1.4, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.1, age: 0 });
      }
    }
  }

  // ---- 更新 ----
  function update(dt, now) {
    clock += dt;
    if (phase !== 'timestop') updateFx(dt);
    const f = dt / 16.67;

    if (phase === 'between') {
      phaseTimer += dt;
      if (phaseTimer >= BETWEEN_MS) startAttack();
    } else if (phase === 'attack') {
      phaseTimer += dt;
      const t = clamp(phaseTimer / ATTACK_MS, 0, 1);
      const z = easeOut(t) * FREEZE_Z;
      for (const p of projectiles) {
        p.z = z;
        p.rot += p.spin * 0.02 * f;
      }
      if (phaseTimer >= ATTACK_MS) startTimestop();
    } else if (phase === 'timestop') {
      const remain = TIMESTOP_MS - (now - stopStart);
      if (!warned && remain <= WARN_MS) {
        warned = true;
        sound.warn();
      }
      if (remain <= 0) beginReplay();
    } else if (phase === 'replay') {
      phaseTimer += dt;
      while (replayIdx < queue.length && phaseTimer >= replayIdx * PUNCH_INTERVAL_MS) {
        executePunch(replayIdx);
        replayIdx += 1;
        if (phase !== 'replay') break; // 転倒か勝ちで終わった
      }
      if (phase !== 'replay') return;
      const t = clamp(phaseTimer / replayDuration, 0, 1);
      for (const p of projectiles) {
        if (!p.alive || p.marked) continue;
        p.z = lerp(FREEZE_Z, ADVANCE_Z, t);
        p.rot += p.spin * 0.02 * f;
      }
      if (replayIdx >= queue.length && phaseTimer >= replayDuration) beginImpact();
    } else if (phase === 'impact') {
      phaseTimer += dt;
      let pending = false;
      for (const p of projectiles) {
        if (!p.alive || p.marked) continue;
        const e = phaseTimer - p.hitAt;
        if (e < 0) {
          pending = true;
          continue;
        }
        const t = clamp(e / IMPACT_MS, 0, 1.3);
        p.z = lerp(ADVANCE_Z, 1.35, t);
        p.rot += p.spin * 0.06 * f;
        if (!p.hitDone && t >= 1) {
          takeHit(p);
          if (phase !== 'impact') return;
        }
        if (t < 1.3) pending = true;
        else p.alive = false;
      }
      if (!pending && phaseTimer > 420) endTurn();
    } else if (phase === 'win' || phase === 'lose') {
      phaseTimer += dt;
      if (phase === 'lose' && topple && !topple.landed && phaseTimer >= TOPPLE_MS * 0.8) toppleLand();
      const delay = phase === 'win' ? RESULT_DELAY_MS : TOPPLE_MS + 900;
      if (!resultShown && phaseTimer >= delay) {
        resultShown = true;
        ui.showResult(true, phase === 'win');
      }
    }

    // 拳の残像
    for (let hand = 0; hand < 2; hand++) {
      const f0 = fistPose(hand);
      if (f0.moving) trails.push({ hand, x: f0.x, y: f0.y, s: f0.s, age: 0 });
    }
  }

  function fistPose(hand) {
    const rest = FIST_REST[hand];
    const p = lastPunch[hand];
    if (!p) return { x: rest.x, y: rest.y, s: 1, moving: false };
    const e = clock - p.start;
    let t;
    let moving = true;
    if (e < 50) t = easeOut(e / 50);
    else if (e < 110) {
      t = 1;
      moving = false;
    } else if (e < 260) t = 1 - easeInOut((e - 110) / 150);
    else {
      t = 0;
      moving = false;
    }
    return { x: lerp(rest.x, p.tx, t), y: lerp(rest.y, p.ty, t), s: 1 - 0.4 * t, moving };
  }

  // ---- 描画 ----
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawBackground(ctx) {
    ctx.fillStyle = WALL;
    ctx.fillRect(-40, -40, W + 80, H + 80);
    // 壁の薄い格子（障子風）
    ctx.strokeStyle = 'rgba(42, 37, 34, 0.08)';
    ctx.lineWidth = 2;
    for (let x = 60; x < W; x += 150) {
      ctx.beginPath();
      ctx.moveTo(x, -40);
      ctx.lineTo(x, 440);
      ctx.stroke();
    }
    for (let y = 40; y < 440; y += 100) {
      ctx.beginPath();
      ctx.moveTo(-40, y);
      ctx.lineTo(W + 40, y);
      ctx.stroke();
    }
    // 床
    ctx.fillStyle = FLOOR;
    ctx.fillRect(-40, 440, W + 80, H - 440 + 40);
    ctx.strokeStyle = 'rgba(42, 37, 34, 0.18)';
    ctx.lineWidth = 2;
    for (let i = -2; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + (i - 3) * 120, 440);
      ctx.lineTo(W / 2 + (i - 3) * 360, H + 40);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-40, 440);
    ctx.lineTo(W + 40, 440);
    ctx.strokeStyle = 'rgba(42, 37, 34, 0.35)';
    ctx.stroke();
  }

  // 台：上面 y=TABLE_Y、幅 TABLE_W。天板と、床へ広がる台座
  function drawTable(ctx) {
    const x0 = CENTER_X - TABLE_W / 2;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = WA.sumi;
    // 台座
    ctx.fillStyle = '#5a3e26';
    ctx.beginPath();
    ctx.moveTo(x0 + 34, TABLE_Y + 20);
    ctx.lineTo(x0 + TABLE_W - 34, TABLE_Y + 20);
    ctx.lineTo(x0 + TABLE_W - 6, H + 20);
    ctx.lineTo(x0 + 6, H + 20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // 天板
    ctx.fillStyle = '#7a5634';
    roundRect(ctx, x0, TABLE_Y, TABLE_W, 22, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 240, 210, 0.22)';
    ctx.fillRect(x0 + 6, TABLE_Y + 3, TABLE_W - 12, 6);
    ctx.strokeStyle = 'rgba(42, 37, 34, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0 + 14, TABLE_Y + 14);
    ctx.lineTo(x0 + TABLE_W - 14, TABLE_Y + 14);
    ctx.stroke();
    // 塔の影（天板の上）
    if (phase !== 'title') {
      const sx = segments.length ? segRect(0).x + SEG_W / 2 + segments[0].dispDx : darumaGeom().cx + daruma.dispDx;
      ctx.fillStyle = 'rgba(42, 37, 34, 0.22)';
      ctx.beginPath();
      ctx.ellipse(sx, TABLE_Y + 1, segments.length ? SEG_W * 0.5 : DARUMA_W * 0.5, 6, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // 段の本体。中心を原点に描く
  function drawSegmentBody(ctx, color, timestopped) {
    const w = SEG_W;
    const h = SEG_H;
    ctx.lineWidth = 3;
    ctx.strokeStyle = WA.sumi;
    ctx.fillStyle = color;
    roundRect(ctx, -w / 2, -h / 2, w, h, 7);
    ctx.fill();
    ctx.stroke();
    // 上面の光と下の影
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(-w / 2 + 7, -h / 2 + 3, w - 14, 7);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(-w / 2 + 7, h / 2 - 8, w - 14, 5);
    // 木目
    ctx.strokeStyle = 'rgba(42, 37, 34, 0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 20, -2);
    ctx.lineTo(w / 2 - 30, -3);
    ctx.moveTo(-w / 2 + 40, 6);
    ctx.lineTo(w / 2 - 16, 5);
    ctx.stroke();
    // 中央の刻み（左半分・右半分の境）
    ctx.strokeStyle = timestopped ? 'rgba(42, 37, 34, 0.5)' : 'rgba(42, 37, 34, 0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -h / 2 + 4);
    ctx.lineTo(0, h / 2 - 4);
    ctx.stroke();
  }

  // 転倒：境目より上の塊が、こちら側へ倒れてくる（大きくなりながら落ちる）
  function applyTopple(ctx, cx, cy, t) {
    const e = t * t;
    ctx.translate(cx + topple.dir * 150 * t, cy + 640 * e);
    const sc = 1 + 2.6 * e;
    ctx.scale(sc, sc);
    ctx.rotate(topple.dir * 0.5 * t);
  }

  function drawTower(ctx, k) {
    const t = phase === 'lose' && topple ? clamp(phaseTimer / TOPPLE_MS, 0, 1) : 0;
    const stopped = phase === 'timestop';
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const r = segRect(i);
      const cx = r.x + r.w / 2 + s.dispDx;
      const cy = r.y + r.h / 2 + s.dispDy;
      ctx.save();
      if (topple && i > topple.k) applyTopple(ctx, cx, cy, t);
      else ctx.translate(cx, cy);
      drawSegmentBody(ctx, s.color, stopped);
      ctx.restore();
    }
    // 敵だるま（転倒のときは必ず落ちる側）
    const dg = darumaGeom();
    const cx = dg.cx + daruma.dispDx;
    const cy = dg.cy + daruma.dispDy;
    ctx.save();
    if (topple) applyTopple(ctx, cx, cy, t);
    else ctx.translate(cx, cy);
    // 足元を支点に傾き・前のめり
    const breathe = stopped ? 0 : 0.012 * Math.sin(clock / 500);
    const wobble = daruma.tilt * (0.6 + 0.4 * Math.sin(clock / 70));
    ctx.translate(0, dg.artH / 2);
    ctx.rotate(wobble);
    ctx.scale(1 + breathe + 0.08 * daruma.lunge, 1 - breathe + 0.06 * daruma.lunge);
    ctx.translate(0, -dg.artH / 2);
    enemyView.draw(ctx, k, 0, 0);
    ctx.restore();
  }

  function drawFlying(ctx) {
    for (const s of flying) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      drawSegmentBody(ctx, s.color, false);
      ctx.restore();
    }
  }

  function drawPlayer(ctx, k) {
    const g = playerView.geom();
    const bottom = PLAYER_CY + g.artH / 2;
    ctx.save();
    ctx.translate(PLAYER_CX, bottom);
    ctx.scale(1 + playerSquash, 1 - playerSquash);
    ctx.translate(-PLAYER_CX, -bottom);
    playerView.draw(ctx, k, PLAYER_CX, PLAYER_CY);
    ctx.restore();
    ctx.fillStyle = WA.sumi;
    ctx.font = `13px ${MINCHO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`自分　ヒビ ${cracks}`, PLAYER_CX - PLAYER_W / 2, PLAYER_CY - PLAYER_W / 2 - 26);
  }

  function drawProjectile(ctx, p) {
    const pos = projPos(p);
    const s = projScale(p.z);
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(p.rot);
    ctx.scale(s, s);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = WA.sumi;
    if (p.kind === 'wood') {
      ctx.fillStyle = '#9a6633';
      ctx.beginPath();
      ctx.moveTo(-34, -10);
      ctx.lineTo(30, -12);
      ctx.lineTo(36, -2);
      ctx.lineTo(32, 11);
      ctx.lineTo(-30, 12);
      ctx.lineTo(-37, 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(70, 40, 15, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-26, -3);
      ctx.lineTo(24, -4);
      ctx.moveTo(-22, 5);
      ctx.lineTo(20, 5);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#8a867e';
      ctx.beginPath();
      ctx.moveTo(-28, -8);
      ctx.lineTo(-10, -27);
      ctx.lineTo(16, -24);
      ctx.lineTo(30, -2);
      ctx.lineTo(20, 24);
      ctx.lineTo(-8, 28);
      ctx.lineTo(-27, 14);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.beginPath();
      ctx.moveTo(-8, -20);
      ctx.lineTo(10, -18);
      ctx.lineTo(0, -4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // 丸みのある手袋型の拳。hand 0 が左手（親指は内側）
  function drawFist(ctx, hand, x, y, s, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(hand === 0 ? s : -s, s);
    const w = FIST_W;
    const h = FIST_W * 0.86;
    ctx.lineWidth = 4;
    ctx.strokeStyle = WA.sumi;
    ctx.fillStyle = '#c8311c';
    // 握りこぶし
    ctx.beginPath();
    ctx.moveTo(-w / 2, 10);
    ctx.lineTo(-w / 2, -h / 2 + 28);
    ctx.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + 28, -h / 2);
    ctx.lineTo(w / 2 - 30, -h / 2);
    ctx.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + 30);
    ctx.lineTo(w / 2, 14);
    ctx.quadraticCurveTo(w / 2, 40, w / 2 - 26, 40);
    ctx.lineTo(-w / 2 + 26, 40);
    ctx.quadraticCurveTo(-w / 2, 40, -w / 2, 14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // 親指
    ctx.beginPath();
    ctx.ellipse(w / 2 - 6, 6, 20, 26, 0.3, 0, TAU);
    ctx.fill();
    ctx.stroke();
    // 指の筋
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(42, 37, 34, 0.55)';
    for (let i = 1; i <= 3; i++) {
      const fx = -w / 2 + (w / 4) * i;
      ctx.beginPath();
      ctx.moveTo(fx, -h / 2 + 4);
      ctx.quadraticCurveTo(fx - 6, -h / 2 + 22, fx, -h / 2 + 40);
      ctx.stroke();
    }
    // 手首の白い縁
    ctx.fillStyle = WA.shiro;
    ctx.strokeStyle = WA.sumi;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.rect(-w / 2 + 6, 40, w - 12, 30);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawImpact(ctx, im) {
    const t = im.age / im.dur;
    const r = im.size * (0.6 + 0.8 * easeOut(t));
    ctx.save();
    ctx.translate(im.x, im.y);
    ctx.globalAlpha = 1 - t;
    // 衝撃の星
    ctx.fillStyle = im.color;
    ctx.strokeStyle = WA.sumi;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i * TAU) / 16;
      const rr = i % 2 ? r * 0.45 : r;
      if (i) ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // 放射線
    ctx.strokeStyle = WA.sumi;
    ctx.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
      const a = (i * TAU) / 8 + 0.2;
      const r0 = r * 1.2;
      const r1 = r * (1.6 + 1.1 * t);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMarks(ctx) {
    ctx.save();
    ctx.lineWidth = 3;
    ctx.font = `bold 16px ${MINCHO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const m of marks) {
      if (m.kind === 'proj') {
        const r = m.r + 8;
        ctx.strokeStyle = WA.kin;
        ctx.beginPath();
        ctx.arc(m.x, m.y, r, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(m.x - r * 0.6, m.y - r * 0.6);
        ctx.lineTo(m.x + r * 0.6, m.y + r * 0.6);
        ctx.moveTo(m.x + r * 0.6, m.y - r * 0.6);
        ctx.lineTo(m.x - r * 0.6, m.y + r * 0.6);
        ctx.stroke();
        ctx.fillStyle = WA.kin;
        ctx.fillText(m.label, m.x + r + 10, m.y - r * 0.5);
      } else {
        ctx.fillStyle = WA.shu;
        ctx.strokeStyle = WA.shiro;
        ctx.beginPath();
        ctx.arc(m.x, m.y, 7, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = WA.shiro;
        ctx.textAlign = 'left';
        ctx.fillText(m.label, m.x + 11, m.y - 12);
        ctx.textAlign = 'center';
      }
    }
    ctx.restore();
  }

  // 時間停止中の塔の読み取り補助：0 目の目安線と、段ごとの予約済みのずれの合計（矢印）
  function drawTowerGuide(ctx) {
    ctx.save();
    const dr = darumaRect();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(CENTER_X, dr.y - 24);
    ctx.lineTo(CENTER_X, TABLE_Y);
    ctx.stroke();
    ctx.setLineDash([]);
    const net = reservedNet();
    ctx.font = `bold 24px ${MINCHO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (!net.has(s.id)) continue;
      const n = net.get(s.id);
      const text = n > 0 ? '→'.repeat(n) : n < 0 ? '←'.repeat(-n) : '±0';
      const r = segRect(i);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      ctx.strokeText(text, cx, cy);
      ctx.fillStyle = WA.kin;
      ctx.fillText(text, cx, cy);
    }
    ctx.restore();
  }

  function drawCountdown(ctx, now) {
    const remain = Math.max(0, TIMESTOP_MS - (now - stopStart));
    const warn = remain <= WARN_MS;
    const text = (Math.floor(remain / 100) / 10).toFixed(1);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const pulse = warn ? 1 + 0.08 * Math.sin(now / 60) : 1;
    ctx.translate(W / 2, 14);
    ctx.scale(pulse, pulse);
    ctx.font = `bold 64px ${MINCHO}`;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = warn ? WA.shu : WA.shiro;
    ctx.fillText(text, 0, 0);
    ctx.font = `18px ${MINCHO}`;
    ctx.lineWidth = 4;
    ctx.strokeText('時が止まっている', 0, 72);
    ctx.fillStyle = WA.shiro;
    ctx.fillText('時が止まっている', 0, 72);
    ctx.restore();
  }

  function drawHud(ctx) {
    ctx.save();
    ctx.font = `18px ${MINCHO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = WA.sumi;
    ctx.fillText(`${turn} 回目`, 18, 14);
    // 抜いた段の数
    const bx = 18;
    const by = 44;
    ctx.fillText('抜いた段', bx, by - 2);
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      ctx.fillStyle = i < removed ? WA.shu : 'rgba(42, 37, 34, 0.2)';
      ctx.fillRect(bx + 82 + i * 22, by + 1, 18, 14);
      ctx.strokeStyle = WA.sumi;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + 82 + i * 22, by + 1, 18, 14);
    }
    ctx.fillStyle = WA.sumi;
    ctx.font = `15px ${MINCHO}`;
    ctx.fillText(`漏れ ${leaks}`, bx, by + 24);
    ctx.restore();
  }

  function drawBanner(ctx) {
    if (!banner) return;
    const t = clamp(banner.age / 320, 0, 1);
    const pop = 0.7 + 0.3 * easeOut(t) + (t < 1 ? 0.15 * Math.sin(t * Math.PI) : 0);
    ctx.save();
    ctx.translate(W / 2, H / 2 - 20);
    ctx.rotate(-0.06);
    ctx.scale(pop, pop);
    ctx.globalAlpha = t;
    ctx.font = `bold 120px ${MINCHO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 14;
    ctx.strokeStyle = WA.shiro;
    ctx.strokeText(banner.text, 0, 0);
    ctx.fillStyle = banner.color;
    ctx.fillText(banner.text, 0, 0);
    ctx.restore();
  }

  function drawFireworks(ctx) {
    for (const s of shells) {
      const t = s.t / s.dur;
      const x = lerp(s.x, s.tx, t);
      const y = lerp(s.y, s.ty, easeOut(t));
      ctx.fillStyle = WA.kin;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, TAU);
      ctx.fill();
    }
    for (const b of bursts) {
      const t = b.age / 1300;
      const d = 90 * easeOut(Math.min(1, b.age / 700));
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = b.color;
      for (const p of b.parts) {
        const x = b.x + Math.cos(p.a) * d * p.v * 0.3;
        const y = b.y + Math.sin(p.a) * d * p.v * 0.3 + 60 * t * t;
        ctx.beginPath();
        ctx.arc(x, y, 3.2 * (1 - t) + 1, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    for (const p of petals) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = '#f0a8b8';
      ctx.beginPath();
      ctx.ellipse(0, 0, 7, 4.5, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  function render(ctx, k, now) {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(shakeX, shakeY);
    drawBackground(ctx);
    drawTable(ctx);
    if (phase !== 'title') drawTower(ctx, k);
    drawFlying(ctx);
    // 飛来物は奥から順に
    const sorted = projectiles.filter((p) => p.alive).sort((a, b) => a.z - b.z);
    for (const p of sorted) drawProjectile(ctx, p);
    // 拳の残像と拳
    for (const tr of trails) drawFist(ctx, tr.hand, tr.x, tr.y, tr.s, 0.35 * (1 - tr.age / 140));
    for (let hand = 0; hand < 2; hand++) {
      const f = fistPose(hand);
      drawFist(ctx, hand, f.x, f.y, f.s, 1);
    }
    for (const s of shards) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.globalAlpha = clamp(1 - s.age / s.dur, 0, 1);
      ctx.fillStyle = s.color;
      ctx.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
      ctx.restore();
    }
    for (const im of impacts) drawImpact(ctx, im);
    drawPlayer(ctx, k);
    ctx.restore();

    if (phase === 'timestop') {
      // 減色＋反転寄りの色調。この上に印と残り時間を描くので、それらは普通の色で読める
      ctx.save();
      ctx.globalCompositeOperation = 'saturation';
      ctx.fillStyle = 'hsl(0, 25%, 50%)';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(30, 40, 90, 0.18)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      drawTowerGuide(ctx);
      drawMarks(ctx);
      drawCountdown(ctx, now);
    }

    if (flash) {
      ctx.fillStyle = `rgba(${flash.color}, ${clamp(flash.alpha, 0, 1)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (phase !== 'title') drawHud(ctx);
    drawFireworks(ctx);
    drawBanner(ctx);
  }

  // ---- DOM と起動 ----
  const wrap = document.getElementById('stage-wrap');
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const titleEl = document.getElementById('title');
  const resultEl = document.getElementById('result');
  const resultText = document.getElementById('result-text');
  const resultSub = document.getElementById('result-sub');
  const btnGo = document.getElementById('btn-go');

  const ui = {
    showTitle(on) {
      titleEl.hidden = !on;
    },
    showResult(on, win) {
      resultEl.hidden = !on;
      if (on) {
        resultText.textContent = win ? '勝ち' : '負け';
        resultText.className = win ? 'win' : '';
        resultSub.textContent = win
          ? `${turn} 回で全部抜いた。だるまのずれ ${finalDarumaOffset} 目、漏れ ${leaks}`
          : `${turn} 回目に転倒。抜いた段 ${removed}、漏れ ${leaks}`;
      }
    },
    showGo(on) {
      btnGo.hidden = !on;
    },
  };

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
    return { x: ((ev.clientX - rect.left) * W) / rect.width, y: ((ev.clientY - rect.top) * H) / rect.height };
  }

  // 自動再生の制限への対策：最初のポインター操作で音を用意する
  window.addEventListener('pointerdown', () => sound.init(), true);

  canvas.addEventListener('pointerdown', (ev) => {
    const p = toLogical(ev);
    if (handleClick(p.x, p.y) !== null) ev.preventDefault();
  });

  document.getElementById('btn-start').addEventListener('click', () => {
    sound.init();
    startBattle();
  });
  document.getElementById('btn-retry').addEventListener('click', () => {
    sound.init();
    startBattle();
  });
  btnGo.addEventListener('click', () => beginReplay());

  // テスト用フック
  window.__game = {
    state() {
      return {
        phase,
        turn,
        offsets: segments.map((s) => s.offset),
        darumaOffset,
        removed,
        leaks,
        cracks,
        queueLength: queue.length,
        projectiles: projectiles
          .filter((p) => p.alive)
          .map((p) => {
            const pos = projPos(p);
            return { x: pos.x, y: pos.y, kind: p.kind, marked: p.marked };
          }),
        segments: segments.map((s, i) => {
          const r = segRect(i);
          return { x: r.x, y: r.y, w: r.w, h: r.h, offset: s.offset };
        }),
        darumaRect: darumaRect(),
      };
    },
    clickAt(x, y) {
      return handleClick(x, y);
    },
    forceResume() {
      beginReplay();
    },
    newBattle() {
      startBattle();
    },
  };

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(50, now - last);
    last = now;
    update(dt, now);
    render(ctx, canvas.width / W, now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
