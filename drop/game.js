// オラオラだるまおとし（吹っ飛ばし試作）
// 主観視点のターン制。段の塔の上に乗った敵だるまが飛来物を投げ、それが途中で止まる。
// 時間停止の間に「飛来物の迎撃」と「段を殴る」を予約し、まとめて再生する。
// 段には耐久があり、尽きた段は奥へ吹っ飛んで消え、上の段とだるまは一段分ストンと落ちる（離散。物理計算なし）。
// 素の Canvas 2D と WebAudio だけで書く。論理画面は 960×540。
(function () {
  'use strict';

  // ---- 調整値 ----
  const W = 960;
  const H = 540;
  const TIMESTOP_MS = 4000; // 時間停止フェイズの長さ（実時間）
  const PUNCH_INTERVAL_MS = 60; // 再生フェイズで拳を繰り出す間隔
  const SEGMENT_COUNT = 5; // 段の数
  const SEG_HP = 6; // 段の耐久（この打数で吹っ飛ぶ）
  const PLAYER_HP = 6; // 自だるまが砕けるまでの被弾数
  // 飛来物の数 = min(PROJ_MAX, PROJ_BASE + floor(ターン × PROJ_TURN_NUM / PROJ_TURN_DEN))（ora と同じ）
  const PROJ_BASE = 4;
  const PROJ_MAX = 14;
  const PROJ_TURN_NUM = 2;
  const PROJ_TURN_DEN = 3;

  const SEG_W = 300; // 段の幅
  const SEG_H = 36; // 段の高さ
  const TABLE_Y = 470; // 台の上面
  const TABLE_W = 340; // 台の幅
  const CENTER_X = 480; // 塔の中心
  const DARUMA_W = 150; // 敵だるまの絵の幅（透明部分を除いた絵の幅）
  const SEG_COLORS = ['#d9482b', '#2e4a7a', '#d9a83a', '#4e7d4a', '#7a4a6e', '#b07040', '#5a8a8a'];

  const BLOW_MS = 300; // 段が奥へ吸い込まれて消えるまで
  const FALL_MS = 150; // 一段分（SEG_H）を落ち切るまでの目安
  const FALL_G = (2 * SEG_H) / (FALL_MS * FALL_MS); // 落下の加速（px/ms²）。静止から FALL_MS で SEG_H 落ちる
  const BOUNCE_MS = 150; // 着地の小さな跳ね
  const BLOW_PAUSE_MS = 560; // 吹っ飛びのあと、拳の再生を止めて見せ場を読ませる時間
  const VANISH_Y = 110; // 吹っ飛ぶ段が吸い込まれる一点の高さ（x は塔の中心）

  const ATTACK_MS = 750; // 飛来物が塔から出て止まるまでの時間
  const FREEZE_Z = 0.6; // 時間停止時の奥行き（0 = 投げ手の位置、1 = プレイヤーの顔）
  const ADVANCE_Z = 0.85; // 再生中に迎撃されなかった飛来物が近づく奥行き
  const IMPACT_STAGGER_MS = 170; // 被弾の間隔
  const IMPACT_MS = 220; // 被弾ひとつの飛び込み時間
  const BETWEEN_MS = 650; // ターンの間の息つぎ
  const WARN_MS = 1000; // 残りこの時間を切ると表示色が変わる
  const RESULT_DELAY_MS = 1500; // 決着から結果の箱を出すまで
  const CRACK_REF_W = 380; // だるまのヒビの大きさの基準（ora の敵だるまの幅）

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

  // ---- 決定的な乱数（同じクリック列 → 同じヒビ・同じ結果にするため、ゲームの論理は全部これを使う） ----
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

  // 打点（絵の中心からの相対座標）と何打目かから、だるまのヒビの形を決定的に作る（ora と同じ）
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

  // 段のヒビ。段の番号と何打目かから決定的に作る（段の中心を原点にした座標）。横長の板なので横に走りやすくする
  function generateSegCrack(segId, n) {
    const rng = mulberry32(hash3(segId, n, 101));
    const x = (rng() - 0.5) * (SEG_W - 70);
    const y = (rng() - 0.5) * (SEG_H - 12);
    const branches = [];
    const nb = 2 + Math.floor(rng() * 3);
    const a0 = rng() * TAU;
    for (let b = 0; b < nb; b++) {
      let a = a0 + (b * TAU) / nb + (rng() - 0.5) * 0.8;
      const total = 22 + rng() * 34;
      const segs = 3 + Math.floor(rng() * 3);
      let cx = 0;
      let cy = 0;
      const pts = [];
      for (let s = 0; s < segs; s++) {
        a += (rng() - 0.5) * 1.1;
        const step = (total / segs) * (0.7 + 0.6 * rng());
        cx += Math.cos(a) * step;
        cy += Math.sin(a) * step * 0.55;
        pts.push({ x: cx, y: cy });
      }
      branches.push(pts);
    }
    return { x, y, n, branches };
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
      noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.5), ac.sampleRate);
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
    // 風切り：帯域の中心を f0 → f1 へ滑らせたノイズ
    function sweep(at, dur, vol, f0, f1) {
      const s = ac.createBufferSource();
      s.buffer = noise;
      const f = ac.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.6;
      f.frequency.setValueAtTime(f0, at);
      f.frequency.exponentialRampToValueAtTime(f1, at + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + dur * 0.3);
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
      // 拳の打撃（飛来物向け）。p = 再生の進み（0→1）で音程が上がる
      punch(p) {
        if (!live()) return;
        const t = ac.currentTime;
        const f = 200 + 320 * p;
        hiss(t, 0.05, 0.45, 'bandpass', 1100 + 1500 * p, 1.3);
        tone(f, f * 0.55, t, 0.1, 0.5, 'triangle');
        tone(120, 60, t, 0.09, 0.35, 'sine');
      },
      // 段を殴る：木を打つ音。再生が進むと音程が上がる
      knock(p) {
        if (!live()) return;
        const t = ac.currentTime;
        hiss(t, 0.04, 0.4, 'bandpass', 900 + 1400 * p, 1.2);
        wood(2 + Math.floor(p * 6), 0.95, t);
        tone(110, 55, t, 0.08, 0.3, 'sine');
      },
      // 段が吹っ飛ぶ：大きめの破裂音と風切り
      blow() {
        if (!live()) return;
        const t = ac.currentTime;
        tone(85, 28, t, 0.45, 0.95, 'sine');
        hiss(t, 0.12, 0.65, 'lowpass', 520, 0.7);
        hiss(t, 0.05, 0.45, 'bandpass', 1600, 1.2);
        wood(1, 0.8, t + 0.01);
        sweep(t + 0.03, 0.32, 0.4, 500, 3400);
      },
      // 落下の着地：低い音
      land(big) {
        if (!live()) return;
        const t = ac.currentTime;
        if (big) {
          tone(90, 34, t, 0.36, 0.85, 'sine');
          hiss(t, 0.12, 0.45, 'lowpass', 300, 0.8);
          wood(0, 0.7, t + 0.03);
        } else {
          tone(100, 42, t, 0.2, 0.55, 'sine');
          hiss(t, 0.07, 0.32, 'lowpass', 350, 0.8);
        }
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
  // finish = 最後の段が吹っ飛び、だるまが台へ落ちるのを待っている（着地で win）
  let phase = 'title'; // title | attack | timestop | replay | finish | impact | between | win | lose
  let turn = 0;
  let segments = []; // 残っている段、下から順 { id, hp, hits, color, cracks, jolt, dispDy, holdUntil, vel, bounce }
  let removed = 0; // 吹っ飛ばした段の数
  let playerHits = 0;
  let playerAlive = true;
  let projectiles = [];
  let queue = []; // 予約した拳 { type: 'proj', id } | { type: 'seg', id }
  let marks = []; // 時間停止中に付けた印 { x, y, label, kind }
  let nextProjId = 1;

  let phaseTimer = 0; // フェイズ内の経過（ms、描画のクロックで進める）
  let stopStart = 0; // 時間停止の開始時刻（performance.now）
  let warned = false;
  let replayIdx = 0;
  let replayDuration = 0;
  let replayTotal = 0;
  let replayPause = 0; // 吹っ飛びの見せ場のあいだ拳の再生を止める残り時間
  let punchCount = 0; // 再生の中で何本目の拳か（手を交互に）
  let resultShown = false;

  // 演出
  let clock = 0; // 全フェイズで進む描画用の時計
  // 敵だるまの見た目：落下のずれ（負 = 論理位置より上に描く）、着地の縮み、傾き、投げの前のめり
  const daruma = { dispDy: 0, holdUntil: 0, vel: 0, squash: 0, tilt: 0, lunge: 0 };
  const blowing = []; // 奥へ吹っ飛んでいる段 { cx, cy, color, cracks, hits, id, age }
  const puffs = []; // 土煙 { x, y, vx, vy, r, age, dur }
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
  let lastLandSound = -1000;

  // ---- 塔の幾何（論理位置。落下中の見た目のずれは dispDy で別に持つ） ----
  function segTop(i) {
    return TABLE_Y - SEG_H * (i + 1);
  }
  function segRect(i) {
    return { x: CENTER_X - SEG_W / 2, y: segTop(i), w: SEG_W, h: SEG_H };
  }
  function darumaGeom() {
    const g = enemyView.geom();
    const bottom = TABLE_Y - SEG_H * segments.length;
    return { cx: CENTER_X, cy: bottom - g.artH / 2, bottom, artH: g.artH };
  }
  function darumaRect() {
    const d = darumaGeom();
    return { x: d.cx - DARUMA_W / 2, y: d.bottom - d.artH, w: DARUMA_W, h: d.artH };
  }
  // 見た目の位置（落下のずれ・揺れ・跳ねを足したもの）
  function segVisual(i) {
    const s = segments[i];
    const r = segRect(i);
    return {
      cx: r.x + r.w / 2 + Math.sin(clock / 17 + i * 1.7) * 5 * s.jolt,
      cy: r.y + r.h / 2 + s.dispDy - 6 * Math.sin(Math.PI * s.bounce),
    };
  }
  function stageOf(hits, hp) {
    const r = hits / hp;
    return r >= 2 / 3 ? 2 : r >= 1 / 3 ? 1 : 0;
  }

  // ---- 飛来物（ora と同じ値。投げ手は塔の上の敵だるま） ----
  function projPos(p) {
    return { x: lerp(p.ox, p.dx, p.z), y: lerp(p.oy, p.dy, p.z) };
  }
  function projScale(z) {
    return 0.35 + 1.1 * z;
  }
  function projRadius(p) {
    return (p.kind === 'wood' ? 34 : 30) * projScale(p.z);
  }

  function projectileCount(t) {
    return Math.min(PROJ_MAX, PROJ_BASE + Math.floor((t * PROJ_TURN_NUM) / PROJ_TURN_DEN));
  }

  function spawnProjectiles() {
    const rng = mulberry32(hash3(turn, 7919, 13));
    const slots = [];
    for (const x of [90, 290, 480, 670, 870]) for (const y of [60, 262, 470]) slots.push({ x, y });
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = slots[i];
      slots[i] = slots[j];
      slots[j] = tmp;
    }
    const k = projectileCount(turn);
    const dg = darumaGeom();
    projectiles = [];
    for (let i = 0; i < k; i++) {
      const s = slots[i];
      projectiles.push({
        id: nextProjId++,
        kind: rng() < 0.6 ? 'wood' : 'rock',
        ox: dg.cx + (rng() - 0.5) * 140,
        oy: dg.cy + (rng() - 0.5) * 100,
        dx: s.x + (rng() - 0.5) * 80,
        dy: s.y + (rng() - 0.5) * 60,
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
      segments.push({
        id: i + 1,
        hp: SEG_HP,
        hits: 0,
        color: SEG_COLORS[i % SEG_COLORS.length],
        cracks: [],
        jolt: 0,
        dispDy: 0,
        holdUntil: 0,
        vel: 0,
        bounce: 0,
      });
    }
    removed = 0;
    playerHits = 0;
    playerAlive = true;
    projectiles = [];
    queue = [];
    marks = [];
    enemyView.cracks = [];
    enemyView.stage = 0;
    enemyView.dirty = true;
    playerView.cracks = [];
    playerView.stage = 0;
    playerView.dirty = true;
    daruma.dispDy = daruma.holdUntil = daruma.vel = daruma.squash = daruma.tilt = daruma.lunge = 0;
    blowing.length = 0;
    puffs.length = 0;
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
    replayPause = 0;
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
    punchCount = 0;
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
    replayPause = 0;
    replayTotal = queue.length;
    replayDuration = Math.max(450, queue.length * PUNCH_INTERVAL_MS + 320);
  }

  function executePunch(i) {
    const q = queue[i];
    const p = replayTotal > 1 ? i / (replayTotal - 1) : 0;
    if (q.type === 'proj') {
      const pr = projectiles.find((e) => e.id === q.id);
      if (!pr || !pr.alive) return;
      const hand = punchCount % 2;
      punchCount += 1;
      const pos = projPos(pr);
      lastPunch[hand] = { tx: pos.x, ty: pos.y, start: clock };
      pr.alive = false;
      spawnShards(pos.x, pos.y, pr.kind === 'wood' ? ['#8a5a2b', '#a9743d', '#5e3b1a'] : ['#7d7a74', '#9b978f', '#55524c'], 10, projRadius(pr));
      impacts.push({ x: pos.x, y: pos.y, age: 0, dur: 200, size: 26 * projScale(pr.z), color: WA.kin });
      sound.punch(p);
      sound.shatter(pr.kind, p);
      return;
    }
    const idx = segments.findIndex((s) => s.id === q.id);
    if (idx < 0) return; // 同じ再生の中で先に吹っ飛んだ段。拳は出さず読み飛ばす
    punchSegment(idx, p);
  }

  // 段 idx を殴る。耐久を 1 減らし、ヒビを足す。尽きたら吹っ飛ぶ
  function punchSegment(idx, p) {
    const seg = segments[idx];
    const hand = punchCount % 2;
    punchCount += 1;
    const r = segRect(idx);
    // 拳の着弾点：手の側に寄せた段の面
    const tx = r.x + r.w / 2 + (hand === 0 ? -50 : 50);
    const ty = r.y + r.h / 2 + seg.dispDy;
    lastPunch[hand] = { tx, ty, start: clock };

    seg.hits += 1;
    seg.hp = Math.max(0, seg.hp - 1);
    seg.cracks.push(generateSegCrack(seg.id, seg.hits));
    seg.jolt = 1;
    daruma.tilt += (hand === 0 ? 1 : -1) * 0.05;

    impacts.push({ x: tx, y: ty, age: 0, dur: 220, size: 30, color: WA.shu });
    spawnSparks(tx, ty, 6);
    shake(90, 3 + 3 * p);
    sound.knock(p);

    if (seg.hp <= 0) blowSegment(idx);
  }

  // 段 idx が奥へ吹っ飛ぶ。上の段とだるまは一段分落ちる（BLOW_MS の間だけ宙に留まってから落ちる）
  function blowSegment(idx) {
    const seg = segments[idx];
    const v = segVisual(idx);
    segments.splice(idx, 1);
    removed += 1;
    blowing.push({ cx: CENTER_X, cy: v.cy, color: seg.color, cracks: seg.cracks, hits: seg.hits, id: seg.id, age: 0 });
    const hold = clock + BLOW_MS;
    for (let j = idx; j < segments.length; j++) {
      const s = segments[j];
      s.dispDy -= SEG_H;
      s.holdUntil = hold;
      s.vel = 0;
    }
    daruma.dispDy -= SEG_H;
    daruma.holdUntil = hold;
    daruma.vel = 0;

    impacts.push({ x: CENTER_X, y: v.cy, age: 0, dur: 340, size: 60, color: WA.kin });
    spawnSparks(CENTER_X, v.cy, 12);
    spawnShards(CENTER_X, v.cy, [seg.color, '#8a5a2b', WA.shiro], 10, 70);
    shake(180, 7);
    sound.blow();
    replayPause = Math.max(replayPause, BLOW_PAUSE_MS);

    if (!segments.length) {
      // 最後の段。だるまが台へ落ちて着地したら勝ち
      phase = 'finish';
      phaseTimer = 0;
      for (const p of projectiles) p.alive = false;
    }
  }

  // 落下の一歩。留まり時間を過ぎたら加速して落ち、論理位置に着いたら止まる
  function stepFall(o, dt, isDaruma) {
    if (o.dispDy >= 0) return;
    if (clock < o.holdUntil) return;
    o.vel += FALL_G * dt;
    o.dispDy += o.vel * dt;
    if (o.dispDy >= 0) {
      o.dispDy = 0;
      o.vel = 0;
      onLand(o, isDaruma);
    }
  }

  function onLand(o, isDaruma) {
    const big = isDaruma && phase === 'finish';
    if (isDaruma) {
      daruma.squash = big ? 0.3 : 0.16;
      const dg = darumaGeom();
      spawnPuffs(dg.cx, dg.bottom, big ? 14 : 6, DARUMA_W * 0.5);
    } else {
      o.bounce = 1;
      const i = segments.indexOf(o);
      const r = segRect(i);
      spawnPuffs(CENTER_X, r.y + r.h, 6, SEG_W * 0.5);
    }
    // 同時に着地する段の音は 1 回にまとめる
    if (clock - lastLandSound > 40 || big) {
      lastLandSound = clock;
      sound.land(big);
    }
    if (big) startWin();
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

  function takeHit(p) {
    p.hitDone = true;
    playerHits = Math.min(PLAYER_HP, playerHits + 1);
    const rng = mulberry32(hash3(playerHits, 31, 7));
    const a = rng() * TAU;
    const r = 8 + rng() * 22; // 自だるまの半径 45 の内側
    playerView.cracks.push(generateCrack(playerView, Math.cos(a) * r, Math.sin(a) * r, playerHits));
    playerView.stage = stageOf(playerHits, PLAYER_HP);
    playerView.dirty = true;
    playerSquash = 0.2;
    shake(260, 14);
    flash = { color: '217, 72, 43', alpha: 0.55 };
    sound.hurt();
    if (playerHits >= PLAYER_HP) killPlayer();
  }

  function endTurn() {
    phase = 'between';
    phaseTimer = 0;
    projectiles = [];
  }

  function startWin() {
    phase = 'win';
    phaseTimer = 0;
    ui.showGo(false);
    for (const p of projectiles) p.alive = false;
    const dg = darumaGeom();
    impacts.push({ x: dg.cx, y: dg.cy, age: 0, dur: 500, size: 110, color: WA.kin });
    shake(260, 9);
    flash = { color: '255, 250, 230', alpha: 0.6 };
    banner = { text: '落とした', age: 0, color: WA.shu };
    sound.burst();
    fireworksLeft = 5;
    fireworkTimer = 350;
  }

  function killPlayer() {
    playerAlive = false;
    phase = 'lose';
    phaseTimer = 0;
    ui.showGo(false);
    for (let i = 0; i < 36; i++) {
      const a = Math.random() * TAU;
      const sp = 3 + Math.random() * 9;
      shards.push({
        x: PLAYER_CX + (Math.random() - 0.5) * PLAYER_W,
        y: PLAYER_CY + (Math.random() - 0.5) * PLAYER_W,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 6,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 0.5,
        age: 0,
        dur: 1500 + Math.random() * 600,
        color: ['#c8311c', '#fffcf5', WA.sumi][Math.floor(Math.random() * 3)],
        w: 5 + Math.random() * 12,
        h: 4 + Math.random() * 9,
      });
    }
    for (const p of projectiles) p.alive = false;
    shake(600, 20);
    flash = { color: '120, 20, 20', alpha: 0.75 };
    banner = { text: '砕けた', age: 0, color: WA.sumi };
    sound.fail();
  }

  // ---- 入力 ----
  // 時間停止中のクリック。飛来物 → 迎撃の予約、段 → その段を殴る予約（段のどこでも同じ）。
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
      queue.push({ type: 'proj', id: best.id });
      const pos = projPos(best);
      marks.push({ x: pos.x, y: pos.y, label: String(queue.length), kind: 'proj', r: projRadius(best) });
      sound.mark();
      return 'proj';
    }
    for (let i = segments.length - 1; i >= 0; i--) {
      const r = segRect(i);
      if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue;
      queue.push({ type: 'seg', id: segments[i].id });
      marks.push({ x, y, label: String(queue.length), kind: 'seg' });
      sound.mark();
      return 'seg';
    }
    return null;
  }

  // 段ごとの予約済みの打数（表示用）
  function reservedCount() {
    const n = new Map();
    for (const q of queue) {
      if (q.type !== 'seg') continue;
      n.set(q.id, (n.get(q.id) || 0) + 1);
    }
    return n;
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
  // 土煙：足元の線 (x ± spread, y) から左右へ広がる
  function spawnPuffs(x, y, n, spread) {
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      const ox = (0.5 + Math.random() * 0.5) * spread * side;
      puffs.push({
        x: x + ox,
        y: y - 2 - Math.random() * 4,
        vx: side * (1.2 + Math.random() * 2.2),
        vy: -(0.4 + Math.random() * 0.9),
        r: 5 + Math.random() * 6,
        age: 0,
        dur: 380 + Math.random() * 220,
      });
    }
  }

  function updateTower(dt) {
    for (const s of segments) stepFall(s, dt, false);
    stepFall(daruma, dt, true);
    const kj = Math.pow(0.001, dt / 220);
    for (const s of segments) {
      s.jolt *= kj;
      s.bounce = Math.max(0, s.bounce - dt / BOUNCE_MS);
    }
    daruma.squash *= Math.pow(0.001, dt / 300);
    daruma.tilt *= Math.pow(0.01, dt / 420);
    daruma.lunge = Math.max(0, daruma.lunge - dt / 320);
    for (let i = blowing.length - 1; i >= 0; i--) {
      blowing[i].age += dt;
      if (blowing[i].age > BLOW_MS) blowing.splice(i, 1);
    }
    const f = dt / 16.67;
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.age += dt;
      p.x += p.vx * f;
      p.y += p.vy * f;
      p.vx *= Math.pow(0.1, dt / 400);
      p.r += 0.5 * f;
      if (p.age > p.dur) puffs.splice(i, 1);
    }
  }

  function updateFx(dt) {
    updateTower(dt);
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
      if (replayPause > 0) {
        // 吹っ飛びと落下の見せ場。拳の予定表（phaseTimer）は進めない
        replayPause -= dt;
      } else {
        phaseTimer += dt;
        while (replayIdx < queue.length && phaseTimer >= replayIdx * PUNCH_INTERVAL_MS) {
          executePunch(replayIdx);
          replayIdx += 1;
          if (phase !== 'replay' || replayPause > 0) break; // 決着か、吹っ飛びの間
        }
        if (phase !== 'replay') return;
      }
      const t = clamp(phaseTimer / replayDuration, 0, 1);
      for (const p of projectiles) {
        if (!p.alive || p.marked) continue;
        p.z = lerp(FREEZE_Z, ADVANCE_Z, t);
        p.rot += p.spin * 0.02 * f;
      }
      if (replayPause <= 0 && replayIdx >= queue.length && phaseTimer >= replayDuration) beginImpact();
    } else if (phase === 'finish') {
      phaseTimer += dt;
      if (phaseTimer > 2500) startWin(); // 保険。通常はだるまの着地（onLand）で勝ちになる
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
      if (!resultShown && phaseTimer >= RESULT_DELAY_MS) {
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
      ctx.fillStyle = 'rgba(42, 37, 34, 0.22)';
      ctx.beginPath();
      ctx.ellipse(CENTER_X, TABLE_Y + 1, segments.length ? SEG_W * 0.5 : DARUMA_W * 0.5, 6, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // 段の本体。中心を原点に描く。seg は { color, cracks, hits } を持つ
  function drawSegmentBody(ctx, seg) {
    const w = SEG_W;
    const h = SEG_H;
    ctx.lineWidth = 3;
    ctx.strokeStyle = WA.sumi;
    ctx.fillStyle = seg.color;
    roundRect(ctx, -w / 2, -h / 2, w, h, 7);
    ctx.fill();
    // 上面の光と下の影
    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(-w / 2, -h / 2, w, 8);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(-w / 2, h / 2 - 7, w, 7);
    // 木目
    ctx.strokeStyle = 'rgba(42, 37, 34, 0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 20, -2);
    ctx.lineTo(w / 2 - 30, -3);
    ctx.moveTo(-w / 2 + 40, 7);
    ctx.lineTo(w / 2 - 16, 6);
    ctx.stroke();
    // ヒビ。段階：0 = 薄い、1 = 中、2 = 大（打数の割合で決まる）
    if (seg.cracks.length) {
      const stage = stageOf(Math.min(seg.hits, SEG_HP - 1), SEG_HP);
      const lenMul = [0.45, 0.8, 1.2][stage];
      const lw = [1.2, 2, 3][stage];
      const alpha = [0.5, 0.85, 1][stage];
      if (stage >= 1) {
        ctx.fillStyle = `rgba(0, 0, 0, ${0.07 * stage})`;
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const cr of seg.cracks) {
        for (const br of cr.branches) {
          ctx.beginPath();
          ctx.moveTo(cr.x, cr.y);
          for (const p of br) ctx.lineTo(cr.x + p.x * lenMul, cr.y + p.y * lenMul);
          ctx.strokeStyle = `rgba(36, 22, 16, ${alpha})`;
          ctx.lineWidth = lw;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cr.x - 0.8, cr.y - 0.8);
          for (const p of br) ctx.lineTo(cr.x + p.x * lenMul - 0.8, cr.y + p.y * lenMul - 0.8);
          ctx.strokeStyle = `rgba(255, 244, 226, ${0.45 * alpha})`;
          ctx.lineWidth = lw * 0.4;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
    ctx.lineWidth = 3;
    ctx.strokeStyle = WA.sumi;
    roundRect(ctx, -w / 2, -h / 2, w, h, 7);
    ctx.stroke();
  }

  // 奥へ吹っ飛ぶ段：一点（CENTER_X, VANISH_Y）へ縮みながら上がって消える。塔より奥に描く
  function drawBlowing(ctx) {
    for (const b of blowing) {
      const t = clamp(b.age / BLOW_MS, 0, 1);
      const e = easeOut(t);
      const sc = lerp(1, 0.08, e);
      const y = lerp(b.cy, VANISH_Y, e);
      ctx.save();
      ctx.globalAlpha = 1 - t * t;
      ctx.translate(b.cx, y);
      ctx.rotate((b.id % 2 ? 1 : -1) * 0.35 * t);
      ctx.scale(sc, sc);
      drawSegmentBody(ctx, b);
      ctx.restore();
    }
  }

  function drawTower(ctx, k) {
    const stopped = phase === 'timestop';
    for (let i = 0; i < segments.length; i++) {
      const v = segVisual(i);
      ctx.save();
      ctx.translate(v.cx, v.cy);
      drawSegmentBody(ctx, segments[i]);
      ctx.restore();
    }
    // 敵だるま。足元を支点に傾き・前のめり・着地の縮み
    const dg = darumaGeom();
    const bottom = dg.bottom + daruma.dispDy;
    ctx.save();
    ctx.translate(dg.cx, bottom);
    const breathe = stopped ? 0 : 0.012 * Math.sin(clock / 500);
    const wobble = daruma.tilt * (0.6 + 0.4 * Math.sin(clock / 70));
    ctx.rotate(wobble);
    ctx.scale(1 + breathe + 0.08 * daruma.lunge + daruma.squash, 1 - breathe + 0.06 * daruma.lunge - daruma.squash);
    enemyView.draw(ctx, k, 0, -dg.artH / 2);
    ctx.restore();
  }

  function drawPuffs(ctx) {
    for (const p of puffs) {
      const t = p.age / p.dur;
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - t);
      ctx.fillStyle = '#ddd0b4';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPlayer(ctx, k) {
    if (!playerAlive) return;
    const g = playerView.geom();
    const bottom = PLAYER_CY + g.artH / 2;
    ctx.save();
    ctx.translate(PLAYER_CX, bottom);
    ctx.scale(1 + playerSquash, 1 - playerSquash);
    ctx.translate(-PLAYER_CX, -bottom);
    playerView.draw(ctx, k, PLAYER_CX, PLAYER_CY);
    ctx.restore();
    // 被弾の目盛り
    ctx.fillStyle = WA.sumi;
    ctx.font = `13px ${MINCHO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('自分', PLAYER_CX - PLAYER_W / 2, PLAYER_CY - PLAYER_W / 2 - 26);
    for (let i = 0; i < PLAYER_HP; i++) {
      ctx.fillStyle = i < PLAYER_HP - playerHits ? WA.shu : 'rgba(42, 37, 34, 0.25)';
      ctx.fillRect(PLAYER_CX - PLAYER_W / 2 + 34 + i * 10, PLAYER_CY - PLAYER_W / 2 - 22, 7, 9);
    }
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

  // 時間停止中の塔の読み取り補助：段ごとの「あと何打で吹っ飛ぶか」。
  // 左に SEG_HP 個の丸（金 = 予約を引いても残る耐久、朱 = 予約済みの打数、灰 = すでに失った耐久）、右に「あと N」
  function drawTowerGuide(ctx) {
    const reserved = reservedCount();
    ctx.save();
    ctx.textBaseline = 'middle';
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const r = segRect(i);
      const cy = r.y + r.h / 2;
      const res = reserved.get(s.id) || 0;
      const remain = s.hp - res;
      // 丸の列
      const x0 = r.x + 16;
      for (let d = 0; d < SEG_HP; d++) {
        const x = x0 + d * 12;
        ctx.beginPath();
        ctx.arc(x, cy, 4, 0, TAU);
        if (d < remain) {
          ctx.fillStyle = WA.kin;
          ctx.fill();
        } else if (d < s.hp) {
          ctx.fillStyle = WA.shu;
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
      // 残り数
      const text = remain > 0 ? `あと ${remain}` : '吹っ飛ぶ';
      ctx.font = `bold 20px ${MINCHO}`;
      ctx.textAlign = 'right';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.strokeText(text, r.x + r.w - 14, cy);
      ctx.fillStyle = remain > 0 ? WA.shiro : WA.shu;
      ctx.fillText(text, r.x + r.w - 14, cy);
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
    // 吹っ飛ばした段の数
    const bx = 18;
    const by = 44;
    ctx.fillText('吹っ飛ばした段', bx, by - 2);
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      ctx.fillStyle = i < removed ? WA.shu : 'rgba(42, 37, 34, 0.2)';
      ctx.fillRect(bx + 136 + i * 22, by + 1, 18, 14);
      ctx.strokeStyle = WA.sumi;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + 136 + i * 22, by + 1, 18, 14);
    }
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
    drawBlowing(ctx);
    drawTable(ctx);
    if (phase !== 'title') drawTower(ctx, k);
    drawPuffs(ctx);
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
          ? `${turn} 回で全部吹っ飛ばした。被弾 ${playerHits}`
          : `${turn} 回目に砕けた。吹っ飛ばした段 ${removed}`;
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
        playerHits,
        segments: segments.map((s, i) => {
          const r = segRect(i);
          return { x: r.x, y: r.y, w: r.w, h: r.h, hp: s.hp, maxHp: SEG_HP };
        }),
        darumaRect: darumaRect(),
        removed,
        projectiles: projectiles
          .filter((p) => p.alive)
          .map((p) => {
            const pos = projPos(p);
            return { x: pos.x, y: pos.y, kind: p.kind, marked: p.marked };
          }),
        queueLength: queue.length,
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
