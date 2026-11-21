// オラオラだるまおとし（吹っ飛ばし試作）
// 主観視点のターン制。段の塔の上に乗った敵だるまが飛来物を投げ、それが途中で止まる。
// 時間停止の間に「飛来物の迎撃」と「段を殴る」を予約し、まとめて再生する。
// 段には耐久があり、尽きた段は奥へ吹っ飛んで消え、上の段とだるまは一段分ストンと落ちる（離散。物理計算なし）。
// 段は一画面に収まるのが実質 1 個という大きさ（高さ 500。幅は段ごとに 380〜700）。塔は画面の上端をはるかに超え、敵だるまは最後の段が抜けるまで
// 完全に画面の外にいる。段を吹っ飛ばすたびに次の巨大な段が上から落ちてくる。段の構成（幅・耐久・種類）は LEVEL で持つ。
// 最後の段を吹っ飛ばすとだるまが画面の上から落ちてきて台に着地し、最終段階として本体を殴れるようになる。耐久が尽きたら破裂して勝ち。
// 戦闘開始の導入：台は空で、塔全体が画面の上から落ちてきて一番下の段が台に着地する（段が吹っ飛んだあとの落下と同じ重さ）。
// 脆い段は縦に積んだ丸太の輪切りとしてコードで描く。主観視点では静止中の段は樹皮の側面しか見えない（上面は画面の上、底面は台や下の段に接している）ので、
// 木口（切り口と年輪）は「落下中の段の底面」と「枝の切り株」にだけ出す。輪郭は左右が垂直、上端は ∩ の弧、下端は ∪ の弧（水平線 y=440 からの距離で膨らみが決まる）。
// 陰影は左右方向（光の帯は中央より少し左）、樹皮の筋は縦に流れる波線。模様は段ごとのシードで決めて保持し、静的な部分はオフスクリーンへ一度焼く。
// 素の Canvas 2D と WebAudio だけで書く。論理画面は 960×540。
(function () {
  'use strict';

  // ---- 調整値 ----
  const W = 960;
  const H = 540;
  const TIMESTOP_MS = 4000; // 時間停止フェイズの長さ（実時間）
  const PUNCH_INTERVAL_MS = 60; // 再生フェイズで拳を繰り出す間隔
  // 段の種類。脆い段 = 明るい木、硬い段 = 暗い石に金属の帯。耐久の数字は画面に出さず、色と幅で硬さを読ませる
  // 今回の面の構成（下から順＝最初に戦う段から）。段ごとに幅 w・初期 hp・maxHp・種類・色味を持つ。
  //  1 段目：脆い木、幅 620、5 打
  //  2 段目：脆い木（細い）、幅 380、maxHp 5 に対して hp 4 で始める（最初から 1 打分のヒビが入った「少し弱っている」段）。色味は明るいほう
  //  3 段目：脆い木（太い）、幅 700、7 打。色味は濃いほうに固定
  //  4 段目：硬い石、幅 620、10 打
  // tone: 'light' = 明るい樹皮（LOG_BASE_WARM）に固定、'dark' = 濃い樹皮（LOG_BASE_GRAY）に固定、null = 段ごとの乱数で選ぶ（石は使わない）
  const LEVEL = [
    { kind: 'fragile', w: 620, hp: 5, maxHp: 5, tone: null },
    { kind: 'fragile', w: 380, hp: 4, maxHp: 5, tone: 'light' },
    { kind: 'fragile', w: 700, hp: 7, maxHp: 7, tone: 'dark' },
    { kind: 'hard', w: 620, hp: 14, maxHp: 14, tone: null },
  ];
  const SEGMENT_COUNT = LEVEL.length; // 段の数（4）
  const SEG_W_MAX = Math.max(...LEVEL.map((l) => l.w)); // 最も太い段の幅（700）。弧のはみ出しの上限や模様の焼き幅の見込みに使う
  const DARUMA_HP = 12; // 最終段階で敵だるま本体が破裂するまでの打数
  const PLAYER_HP = 6; // 自だるまが砕けるまでの被弾数
  // 飛来物の数 = min(PROJ_MAX, PROJ_BASE + floor(ターン × PROJ_TURN_NUM / PROJ_TURN_DEN))（ora と同じ）
  const PROJ_BASE = 4;
  const PROJ_MAX = 9;
  const PROJ_TURN_NUM = 2;
  const PROJ_TURN_DEN = 3;

  const SEG_W = 620; // 段の基準の幅（1 段目と最上段の石がこの幅）。段ごとの実際の幅は LEVEL の w で持ち、生成・描画・判定はすべて段自身の w を使う
  const SEG_H = 500; // 段の高さ（全段共通。落下・吹っ飛びの距離はすべてここから導く）。一番下の段は台の上面から y = -30 まで届き、見える段は実質 1 個
  const TABLE_Y = 470; // 台の上面
  const TABLE_W = 680; // 台の幅（基準の段の幅 620 に釣り合わせる。太い段 700 は左右に 10px ずつはみ出すが、わずかなので許容）
  const CENTER_X = 480; // 塔の中心
  // 敵だるまの絵の幅（透明部分を除いた絵の幅）。塔の高さ SEG_H × SEGMENT_COUNT = 2000 なので、だるまは最後の段が抜けるまで
  // 完全に画面の外。最後の段が吹っ飛ぶと、画面の上端の外（足元 y = -30）から台まで 500 落ちてきて着地する
  const DARUMA_W = 320;
  const SEG_CRACK_SCALE = SEG_H / 110; // 段のヒビの大きさ（小さい段向けの形をこの倍率で広げる。全面に読める太さと長さにする）
  // 飛来物の投げ元の y の下限。だるまが画面の外にいる間も、時間停止時の飛来物が画面の中で止まるように押し込む
  const THROW_Y_MIN = 70;
  // 届かない拳（段が残っているうちにだるまを叩こうとしたときの空振り）
  const WHIFF_MS = 380; // 伸びて消えるまで
  const WHIFF_OUT_MS = 90; // 伸び切るまで
  const WHIFF_GAP = 36; // だるまの足元からこれだけ手前で止まる
  // 段の色。脆い段は明るい木（丸太の樹皮）、硬い段は暗い石の色。いずれも和風の落ち着いた色味
  const HARD_COLOR = '#575b63';
  const HARD_BAND = '#aaa49a'; // 硬い段の金属の帯
  // 丸太（輪切り）の描き込み。丸太の半径 R は段ごとに w / 2（段の幅が違うので定数にしない）
  const HORIZON_Y = 440; // 主観視点の水平線（drawBackground の壁と床の境と同じ高さ）。輪切りの縁の弧はここからの距離で膨らむ
  const ARC_RATIO = 0.35; // 縁の弧の膨らみの上限（半径に対する割合）
  const ARC_MAX = (SEG_W_MAX / 2) * ARC_RATIO; // 最も太い段での膨らみの上限（122.5）。画面の外の段を描かない判定に使う
  const LOG_TEX_EXT = 125; // 模様を段の箱より上下に広く焼く分（最も太い段の弧のはみ出し ARC_MAX = 122.5 を覆う。高さ 500 と合わせて筋の刻み LOG_STEP で割り切れる値）
  const LOG_STEP = 5; // 樹皮の筋を折れ線にする刻み（px）
  const LOG_BASE_WARM = '#c89a62'; // 樹皮のベース色（赤み寄り）
  const LOG_BASE_GRAY = '#b89770'; // 樹皮のベース色（灰み寄り）
  const LOG_SHADE = '40, 22, 8'; // 陰影の暗
  const LOG_LIGHT = '255, 240, 210'; // 陰影の明
  const LOG_BARK_DARK = '70, 40, 15'; // 樹皮の筋（濃）
  const LOG_BARK_LIGHT = '255, 236, 200'; // 樹皮の筋（淡）
  const LOG_RING = 'rgba(112, 66, 26, 0.5)'; // 年輪の線（枝の切り株にだけ描く）
  const LOG_STUMP_FACE = '#e9d3a6'; // 枝の切り株の木口（淡い木の色。暗い飛来物と逆の明るさに置く）
  const LOG_EDGE_LIGHT = '#e2c796'; // 切り縁の帯（明）
  const LOG_EDGE_DARK = '#6b4a2a'; // 切り縁の帯（暗）
  const LOG_FACE = 'rgba(60, 36, 14, 0.85)'; // 落下中に覗く底面（影の中の木口）
  const LOG_MOSS = '127, 138, 98'; // 苔
  const CRACK_VERT_AVOID = (20 * Math.PI) / 180; // ヒビの枝が真縦からこの角度以内に入らないようにする（縦の樹皮の筋と紛れないため）

  // 戦闘開始の導入（塔が上から落ちてくる）
  const INTRO_HOLD_MS = 350; // 開始から塔が落ち始めるまで（台が空なのを見せる間）
  const INTRO_LAND_PAUSE_MS = 350; // 一番下の段が着地してから第 1 ターンの攻撃までの間

  const BLOW_MS = 350; // 段が奥へ吸い込まれて消えるまで
  const FALL_MS = 300; // 一段分（SEG_H）を落ち切るまでの目安。約 300ms かけて加速して落ちる（落ち始めが遅く、着地直前に最速）
  const FALL_G = (2 * SEG_H) / (FALL_MS * FALL_MS); // 落下の加速（px/ms²）。静止から FALL_MS で SEG_H 落ちる
  const BOUNCE_MS = 220; // 着地の縮み（重い段なので跳ねずに潰れる）
  const BLOW_PAUSE_MS = 800; // 吹っ飛びのあと、拳の再生を止めて見せ場を読ませる時間（吹っ飛び BLOW_MS ＋ 落下 FALL_MS ＋ 着地）
  const VANISH_Y = 140; // 吹っ飛ぶ段が吸い込まれる一点の高さ（x は塔の中心）

  const ATTACK_MS = 450; // 飛来物が塔から出て止まるまでの時間（400 未満にはしない。目で追えずワープに見えるため）
  const FREEZE_Z = 0.6; // 時間停止時の奥行き（0 = 投げ手の位置、1 = プレイヤーの顔）
  const ADVANCE_Z = 0.85; // 再生中に迎撃されなかった飛来物が近づく奥行き
  const IMPACT_STAGGER_MS = 170; // 被弾の間隔
  const IMPACT_MS = 220; // 被弾ひとつの飛び込み時間
  const BETWEEN_MS = 100; // ターンの間の息つぎ（ほぼ無し。着地から次の時間停止までの受け身の時間を詰める）
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

  // 角度 a が真縦（上向き・下向き）の ±CRACK_VERT_AVOID に入っていたら、近い側の外へずらす。
  // 樹皮の筋は縦に流れるので、ヒビの枝が縦に走ると見分けがつかなくなる
  function tiltOffVertical(a, rng) {
    const d = ((((a - Math.PI / 2) % Math.PI) + Math.PI * 1.5) % Math.PI) - Math.PI / 2; // 縦からのずれ（-π/2〜π/2）
    if (Math.abs(d) >= CRACK_VERT_AVOID) return a;
    const s = d !== 0 ? Math.sign(d) : rng() < 0.5 ? -1 : 1;
    return a + s * (CRACK_VERT_AVOID - Math.abs(d));
  }

  // 段のヒビ。段の番号と何打目かから決定的に作る（段の中心を原点にした座標）。w はその段の幅。
  // 巨大な段（w×500）の全面に散らし、枝の長さは SEG_CRACK_SCALE で広げる（100〜250px ほど）。少し横に走りやすくし、
  // さらに枝の向きを真縦 ±20° から外す（縦の樹皮の筋と重ならないように）
  function generateSegCrack(segId, n, w) {
    const rng = mulberry32(hash3(segId, n, 101));
    const x = (rng() - 0.5) * (w - 180);
    const y = (rng() - 0.5) * (SEG_H - 160);
    const branches = [];
    const nb = 2 + Math.floor(rng() * 3);
    const a0 = rng() * TAU;
    for (let b = 0; b < nb; b++) {
      let a = a0 + (b * TAU) / nb + (rng() - 0.5) * 0.8;
      const total = (22 + rng() * 34) * SEG_CRACK_SCALE;
      const segs = 3 + Math.floor(rng() * 3);
      let cx = 0;
      let cy = 0;
      const pts = [];
      for (let s = 0; s < segs; s++) {
        a = tiltOffVertical(a + (rng() - 0.5) * 1.1, rng);
        const step = (total / segs) * (0.7 + 0.6 * rng());
        cx += Math.cos(a) * step;
        cy += Math.sin(a) * step * 0.8;
        pts.push({ x: cx, y: cy });
      }
      branches.push(pts);
    }
    return { x, y, n, branches };
  }

  // 丸太（輪切り）の模様。段の生成時にシードから一度だけ作って段に持たせる（戦闘中の再描画で模様が変わらないように）。
  // 段の中心を原点にした座標。模様は段の箱より上下に LOG_TEX_EXT だけ広く作る（上下の縁の弧がはみ出す分を埋めるため）。
  // 静的な部分は barkTexture() でオフスクリーンへ一度焼いて pat.tex に持つ。
  // w はその段の幅（模様の横の範囲と筋の本数がこれで決まる）。tone は色味の指定（'light' / 'dark' / null = 乱数）
  function makeLogPattern(seed, w, tone) {
    const rng = mulberry32(seed);
    const R = w / 2;
    const h = SEG_H;
    const y0 = -h / 2 - LOG_TEX_EXT;
    const y1 = h / 2 + LOG_TEX_EXT;
    const pick = (a, b) => a + rng() * (b - a);
    const coin = rng() < 0.5; // 色味の乱数は tone 指定があっても 1 回引いておく（以降の乱数列を揃えるため）
    const dens = w / SEG_W; // 幅に応じた密度の倍率（副筋と点描の数を基準の幅に対して増減し、細い段が詰まりすぎないようにする）
    const pat = {
      w, // 段の幅
      R, // 丸太の半径（w / 2）
      base: tone === 'light' ? LOG_BASE_WARM : tone === 'dark' ? LOG_BASE_GRAY : coin ? LOG_BASE_WARM : LOG_BASE_GRAY, // ベース色相（A 赤み寄り＝明るい / B 灰み寄り＝濃い）
      lightShift: (rng() - 0.5) * 0.06, // 光の帯の位置の揺れ（幅に対する割合、±3%）。光の向きそのものは全段で固定
      blotches: [], // 低周波の色むら（柔らかい縦帯）
      knots: [], // 節（生きた節 = 縦長のアーモンド、枝の切り株 = 円。筋はこの周りを迂回する）
      streaks: [], // 樹皮の主筋（縦の波線。途切れ・合流つき。runs に折れ線の区間を持つ）
      subs: [], // 副筋
      peels: [], // 剥がれ（樹皮が浮いた帯）
      chips: [], // 切り縁から垂れる欠け
      moss: [], // 苔
      stippleSeed: Math.floor(rng() * 1e9), // 点描の乱数の種
      faceOff: (rng() - 0.5) * 0.3, // 落下中に覗く底面の年輪の芯のずれ（半径に対する割合）
      faceRings: [], // 底面の年輪（半径に対する割合）
      tex: null, // 焼いた模様
      texK: 0, // 焼いたときの解像度
    };
    // 低周波の色むら
    const nb = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < nb; i++) pat.blotches.push({ x: pick(-R, R), w: pick(90, 160), dark: rng() < 0.5, alpha: pick(0.05, 0.08) });
    // 節。1〜3 個、互いに離して置く。枝の切り株は 1 段に最大 1 個、出現確率 5 割
    const nk = 1 + Math.floor(rng() * 3);
    const stumpAt = rng() < 0.5 ? Math.floor(rng() * nk) : -1;
    for (let i = 0; i < nk; i++) {
      let c = null;
      for (let tries = 0; tries < 10; tries++) {
        const cand = { x: pick(-R + 80, R - 80), y: pick(-h / 2 + 90, h / 2 - 90) };
        if (pat.knots.every((o) => Math.hypot(o.x - cand.x, o.y - cand.y) > 150)) {
          c = cand;
          break;
        }
        c = c || cand;
      }
      if (i === stumpAt) {
        const r = pick(22, 40);
        const rings = [];
        let f = 0.14;
        while (f < 0.86 && rings.length < 7) {
          rings.push(f);
          f += pick(0.09, 0.16);
        }
        // ax/ay = 筋を迂回させる範囲（半径の 1.8 倍）
        pat.knots.push({ kind: 'stump', x: c.x, y: c.y, r, rings, pcx: pick(-0.25, 0.25), pcy: pick(-0.25, 0.25), ax: 1.8 * r, ay: 1.8 * r });
      } else {
        const w = pick(24, 40);
        const hgt = w * pick(2.2, 2.6);
        pat.knots.push({ kind: 'live', x: c.x, y: c.y, w, hgt, rings: 2 + Math.floor(rng() * 2), tilt: (rng() - 0.5) * 0.24, ax: 0.9 * w, ay: 0.9 * hgt });
      }
    }
    // 節の周りで筋を横に迂回させる（石を避ける水の流れ）。xBase は筋の素の位置（どちら側へ逃げるかを決める）
    const deflect = (x, y, xBase) => {
      let out = x;
      for (const k of pat.knots) {
        const d = Math.hypot((x - k.x) / k.ax, (y - k.y) / k.ay);
        if (d >= 1) continue;
        out += (xBase >= k.x ? 1 : -1) * (1 - d) * k.ax;
      }
      return out;
    };
    const wave = (s, y) => s.x + s.amp * Math.sin((TAU * y) / s.wl + s.ph) + s.amp2 * Math.sin((TAU * y) / s.wl2 + s.ph2);
    // 主筋：間隔 30〜45px を揺らして等間隔にしない。1 本は全高を走る波線
    let sx = -R + pick(14, 40);
    while (sx < R - 14) {
      pat.streaks.push({
        x: sx,
        amp: pick(6, 10),
        wl: pick(120, 200),
        ph: rng() * TAU,
        amp2: pick(1, 2.5),
        wl2: pick(40, 70),
        ph2: rng() * TAU,
        width: pick(3, 5),
        alpha: pick(0.22, 0.3),
        gaps: [],
        pts: [],
        runs: [],
      });
      sx += pick(30, 45);
    }
    for (const s of pat.streaks) {
      const ng = 1 + Math.floor(rng() * 3);
      for (let g = 0; g < ng; g++) s.gaps.push({ y: pick(-h / 2 + 30, h / 2 - 80), len: pick(20, 50) });
      for (let y = y0; y <= y1 + 0.01; y += LOG_STEP) s.pts.push({ x: deflect(wave(s, y), y, s.x), y });
    }
    // 合流（Y 字）：隣の 2 本が 60〜100px の区間で寄って 1 本になる。合流した側の筋はそこで終わる
    const nm = 4 + Math.floor(rng() * 3);
    const used = new Set();
    for (let m = 0; m < nm && pat.streaks.length > 1; m++) {
      const j = 1 + Math.floor(rng() * (pat.streaks.length - 1));
      const L = pick(60, 100);
      const ys = pick(-h / 2 + 40, h / 2 - 40 - L);
      const down = rng() < 0.5;
      if (used.has(j) || used.has(j - 1)) continue;
      used.add(j);
      used.add(j - 1);
      const src = pat.streaks[j];
      const dst = pat.streaks[j - 1];
      const kept = [];
      for (let i = 0; i < src.pts.length; i++) {
        const p = src.pts[i];
        const q = dst.pts[i];
        const t = down ? (p.y - ys) / L : (ys + L - p.y) / L;
        if (t > 1) continue;
        const f = t <= 0 ? 0 : t * t * (3 - 2 * t);
        kept.push({ x: lerp(p.x, q.x, f), y: p.y });
      }
      src.pts = kept;
    }
    // 途切れで区間に分ける。筋そのものの両端（模様の端、または合流の先）は yMin / yMax に残し、描くときにそこでは細らせない
    for (const s of pat.streaks) {
      s.yMin = s.pts.length ? s.pts[0].y : y0;
      s.yMax = s.pts.length ? s.pts[s.pts.length - 1].y : y1;
      let cur = [];
      for (const p of s.pts) {
        if (s.gaps.some((g) => p.y >= g.y && p.y <= g.y + g.len)) {
          if (cur.length > 1) s.runs.push(cur);
          cur = [];
        } else cur.push(p);
      }
      if (cur.length > 1) s.runs.push(cur);
      s.pts = null;
    }
    // 副筋：主筋の間を埋める細い波線。長さは全高の 30〜70%。暗 7 割・明 3 割
    const nsub = Math.round((25 + Math.floor(rng() * 11)) * dens);
    for (let i = 0; i < nsub; i++) {
      const len = h * pick(0.3, 0.7);
      const ya = pick(y0, y1 - len);
      const s = {
        x: pick(-R + 10, R - 10),
        amp: pick(4, 8),
        wl: pick(100, 180),
        ph: rng() * TAU,
        amp2: pick(0.5, 1.5),
        wl2: pick(40, 70),
        ph2: rng() * TAU,
        width: pick(1, 2),
        alpha: pick(0.1, 0.16),
        light: rng() < 0.3,
        pts: [],
      };
      for (let y = ya; y <= ya + len; y += LOG_STEP) s.pts.push({ x: deflect(wave(s, y), y, s.x), y });
      pat.subs.push(s);
    }
    // 剥がれ：0〜3 本
    const np = Math.floor(rng() * 4);
    for (let i = 0; i < np; i++) pat.peels.push({ x: pick(-R + 40, R - 40), y: pick(-h / 2 + 100, h / 2 - 100), w: pick(10, 18), h: pick(80, 160), tip: pick(14, 24) });
    // 切り縁の欠け：3〜6 個を上下の縁に振り分ける
    const nc = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < nc; i++) pat.chips.push({ top: rng() < 0.5, x: pick(-R + 40, R - 40), w: pick(10, 20), d: pick(5, 10) });
    // 苔：下 3 分の 1 に 0〜3 個
    if (rng() < 0.65) {
      const nmoss = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < nmoss; i++) pat.moss.push({ x: pick(-R + 60, R - 60), y: pick(h / 2 - h / 3 + 20, h / 2 - 16), rx: pick(28, 60), ry: pick(12, 24), alpha: pick(0.1, 0.15) });
    }
    // 底面の年輪：3〜4 本
    const nf = 3 + Math.floor(rng() * 2);
    for (let i = 0; i < nf; i++) pat.faceRings.push(((i + 1) / (nf + 1)) * 0.9 * pick(0.95, 1.05));
    return pat;
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
      // 段が吹っ飛ぶ：大きめの破裂音と長い風切り（巨大な段が奥へ飛んでいく）
      blow() {
        if (!live()) return;
        const t = ac.currentTime;
        tone(80, 26, t, 0.55, 0.95, 'sine');
        hiss(t, 0.16, 0.7, 'lowpass', 480, 0.7);
        hiss(t, 0.06, 0.45, 'bandpass', 1500, 1.2);
        wood(1, 0.8, t + 0.01);
        sweep(t + 0.04, 0.45, 0.42, 450, 3000);
      },
      // 落下の着地：低い音。段の着地も巨大な塊が落ちる重さで鳴らし、だるまの着地（big）はさらに太く
      land(big) {
        if (!live()) return;
        const t = ac.currentTime;
        if (big) {
          tone(80, 30, t, 0.5, 0.95, 'sine');
          hiss(t, 0.16, 0.5, 'lowpass', 280, 0.8);
          wood(0, 0.8, t + 0.03);
        } else {
          tone(88, 34, t, 0.38, 0.85, 'sine');
          hiss(t, 0.12, 0.45, 'lowpass', 320, 0.8);
          wood(0, 0.5, t + 0.02);
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
      // 届かない拳：空を切る風の音だけ（打撃音は鳴らない）
      whiff() {
        if (!live()) return;
        const t = ac.currentTime;
        sweep(t, 0.2, 0.3, 700, 2600);
        hiss(t + 0.02, 0.05, 0.1, 'highpass', 3000, 1);
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
  // intro = 戦闘開始の導入。台は空で、塔全体が上から落ちてくる（一番下の段が着地するまで。クリックは受け付けない）
  // finish = 最後の段が吹っ飛び、だるまが台へ落ちるのを待っている（着地で最終段階へ）
  let phase = 'title'; // title | intro | attack | timestop | replay | finish | impact | between | win | lose
  let turn = 0;
  let battleNo = 0; // 何戦目か（段の丸太の模様のシードに使う。戦いごとに違う丸太にする）
  let segments = []; // 残っている段、下から順 { id, kind, w, hp, maxHp, hits, color, pattern, cracks, jolt, dispDy, holdUntil, vel, bounce }
  let removed = 0; // 吹っ飛ばした段の数
  let finale = false; // 最終段階（だるまが台の上にいて、本体を殴れる）
  let darumaHits = 0; // 最終段階で本体に入れた打数
  let darumaAlive = true;
  let playerHits = 0;
  let playerAlive = true;
  let projectiles = [];
  let queue = []; // 予約した拳 { type: 'proj', id } | { type: 'seg', id } | { type: 'daruma', x, y }
  let marks = []; // 時間停止中に付けた印 { x, y, label, kind }（label は飛来物の順番。段と本体の印は数字を出さない）
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
  const blowing = []; // 奥へ吹っ飛んでいる段 { cx, cy, kind, w, color, pattern, cracks, hits, maxHp, id, age }
  const puffs = []; // 土煙 { x, y, vx, vy, r, age, dur }
  const lastPunch = [null, null]; // 手ごとの直近の拳 { tx, ty, start }
  const whiffs = [null, null]; // 手ごとの届かない拳 { tx, ty, reach, start }。時間停止中に動くので lastPunch とは別に持つ
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
  let viewK = 1; // 描画の解像度（キャンバスの実画素 / 論理画素）。段の模様をオフスクリーンへ焼くときの倍率に使う

  // ---- 塔の幾何（論理位置。落下中の見た目のずれは dispDy で別に持つ） ----
  function segTop(i) {
    return TABLE_Y - SEG_H * (i + 1);
  }
  // 段 i の論理的な箱。幅はその段自身の w（段ごとに違う）
  function segRect(i) {
    const w = segments[i].w;
    return { x: CENTER_X - w / 2, y: segTop(i), w, h: SEG_H };
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
      cx: r.x + r.w / 2 + Math.sin(clock / 17 + i * 1.7) * 6 * s.jolt,
      cy: r.y + r.h / 2 + s.dispDy,
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
    // 出現位置は「塔の内側」と「塔の外側（左右の余白）」に分けて引く。
    // 毎ターン、外側にもおおよそ半分が散る形にして、迎撃（左右）と攻撃（中央）の場所を分ける。
    // 内側／外側の判定は、いま戦っている一番下の段の幅が基準（段の左右の端の内側にある列が内側。端の上の列も内側に含める）。
    // 段が無い最終段階は基準の幅 SEG_W で判定する。出現位置の列そのもの（x = 90, 290, 480, 670, 870）は固定
    const half = (segments.length ? segments[0].w : SEG_W) / 2;
    const inSlots = [];
    const outSlots = [];
    for (const x of [90, 290, 480, 670, 870]) for (const y of [60, 262, 470]) {
      if (x < CENTER_X - half || x > CENTER_X + half) outSlots.push({ x, y });
      else inSlots.push({ x, y });
    }
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
    };
    shuffle(outSlots);
    shuffle(inSlots);
    const k = projectileCount(turn);
    const outCount = Math.min(outSlots.length, Math.ceil(k / 2));
    const slots = outSlots.slice(0, outCount)
      .concat(inSlots.slice(0, k - outCount));
    if (slots.length < k) {
      const rest = inSlots.slice(k - outCount).concat(outSlots.slice(outCount));
      for (const s of rest) {
        if (slots.length >= k) break;
        slots.push(s);
      }
    }
    const dg = darumaGeom();
    projectiles = [];
    for (let i = 0; i < k; i++) {
      const s = slots[i];
      projectiles.push({
        id: nextProjId++,
        kind: rng() < 0.6 ? 'wood' : 'rock',
        ox: dg.cx + (rng() - 0.5) * 140,
        // だるまが画面の外にいる間は、投げ元を画面の上端の少し下に押し込む（上から降ってくる見え方になる）
        oy: Math.max(THROW_Y_MIN, dg.cy + (rng() - 0.5) * 100),
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
  // 戦闘開始（もう一度、を含む）。台の上は空で、塔全体（段とだるま）が一段分（SEG_H = 500）上に置かれ、
  // INTRO_HOLD_MS 留まってから吹っ飛び後の落下と同じ加速で落ちてくる。一番下の段の着地（onLand）で導入が終わる
  function startBattle() {
    phase = 'intro';
    turn = 0;
    battleNo += 1;
    segments = [];
    const hold = clock + INTRO_HOLD_MS;
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      const def = LEVEL[i];
      const kind = def.kind;
      const pattern = kind === 'hard' ? null : makeLogPattern(hash3(battleNo, i + 1, 977), def.w, def.tone);
      // 初期 hp が maxHp より低い段は、その差だけ最初から殴られている扱いにする（打数とヒビを先に入れておく。2 段目の hp 4 / maxHp 5）
      const hits = def.maxHp - def.hp;
      const cracks = [];
      for (let n = 1; n <= hits; n++) cracks.push(generateSegCrack(i + 1, n, def.w));
      segments.push({
        id: i + 1,
        kind,
        w: def.w,
        hp: def.hp,
        maxHp: def.maxHp,
        hits,
        color: kind === 'hard' ? HARD_COLOR : pattern.base, // 脆い段の色は模様のベース色相（破片の色にも使う）
        pattern,
        cracks,
        jolt: 0,
        dispDy: -SEG_H,
        holdUntil: hold,
        vel: 0,
        bounce: 0,
      });
    }
    removed = 0;
    finale = false;
    darumaHits = 0;
    darumaAlive = true;
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
    daruma.squash = daruma.tilt = daruma.lunge = 0;
    daruma.dispDy = -SEG_H; // だるまも塔と一緒に落ちてくる（画面の外なので見えないが、位置を揃えておく）
    daruma.holdUntil = hold;
    daruma.vel = 0;
    blowing.length = 0;
    puffs.length = 0;
    trails.length = 0;
    impacts.length = 0;
    shards.length = 0;
    petals.length = 0;
    shells.length = 0;
    bursts.length = 0;
    lastPunch[0] = lastPunch[1] = null;
    whiffs[0] = whiffs[1] = null;
    shakeMs = shakeAmp = 0;
    flash = null;
    banner = null;
    playerSquash = 0;
    boomCount = 0;
    fireworksLeft = 0;
    replayPause = 0;
    resultShown = false;
    phaseTimer = 0;
    ui.showTitle(false);
    ui.showResult(false);
    ui.showGo(false);
  }

  // 導入の終わり：一番下の段が着地した。少し間を置いてから第 1 ターンの攻撃へ（between を経由）
  function finishIntro() {
    if (phase !== 'intro') return;
    phase = 'between';
    phaseTimer = BETWEEN_MS - INTRO_LAND_PAUSE_MS;
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
    whiffs[0] = whiffs[1] = null; // 空振りの途中なら消して、再生の拳を手元から出す
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
    if (q.type === 'daruma') {
      if (!finale || !darumaAlive) return;
      punchDaruma(q.x, q.y, p);
      return;
    }
    const idx = segments.findIndex((s) => s.id === q.id);
    if (idx < 0) return; // 同じ再生の中で先に吹っ飛んだ段。拳は出さず読み飛ばす
    punchSegment(idx, p);
  }

  // 最終段階：だるま本体を殴る。打点にヒビを足し（ora と同じ作り）、段階は耐久に対する割合で進む。尽きたら破裂して勝ち
  function punchDaruma(x, y, p) {
    const hand = punchCount % 2;
    punchCount += 1;
    lastPunch[hand] = { tx: x, ty: y, start: clock };
    darumaHits = Math.min(DARUMA_HP, darumaHits + 1);
    const dg = darumaGeom();
    const rx = x - dg.cx;
    const ry = y - dg.cy;
    enemyView.cracks.push(generateCrack(enemyView, rx, ry, darumaHits));
    enemyView.stage = stageOf(darumaHits, DARUMA_HP);
    enemyView.dirty = true;
    impacts.push({ x, y, age: 0, dur: 220, size: 34, color: WA.shu });
    spawnSparks(x, y, 6);
    daruma.squash = 0.12;
    daruma.tilt += clamp(rx / (DARUMA_W / 2), -1, 1) * -0.06;
    shake(90, 3 + 3 * p);
    sound.punch(p);
    if (darumaHits >= DARUMA_HP) killDaruma();
  }

  // 段 idx を殴る。耐久を 1 減らし、ヒビを足す。尽きたら吹っ飛ぶ
  function punchSegment(idx, p) {
    const seg = segments[idx];
    const hand = punchCount % 2;
    punchCount += 1;
    const r = segRect(idx);
    // 拳の着弾点：手の側に寄せた段の面（巨大な段なので中心からその段の幅の 1/4 ほど外へ）
    const tx = r.x + r.w / 2 + (hand === 0 ? -1 : 1) * r.w * 0.24;
    const ty = r.y + r.h / 2 + seg.dispDy;
    lastPunch[hand] = { tx, ty, start: clock };

    seg.hits += 1;
    seg.hp = Math.max(0, seg.hp - 1);
    seg.cracks.push(generateSegCrack(seg.id, seg.hits, seg.w));
    seg.jolt = 1;
    daruma.tilt += (hand === 0 ? 1 : -1) * 0.05;

    impacts.push({ x: tx, y: ty, age: 0, dur: 220, size: 34, color: WA.shu });
    spawnSparks(tx, ty, 8);
    shake(90, 3 + 3 * p);
    sound.knock(p);

    if (seg.hp <= 0) blowSegment(idx);
  }

  // 段 idx が奥へ吹っ飛ぶ。上の段とだるまは一段分（SEG_H = 500）落ちる（BLOW_MS の間だけ宙に留まってから、約 FALL_MS かけて加速して落ちる）
  function blowSegment(idx) {
    const seg = segments[idx];
    const v = segVisual(idx);
    segments.splice(idx, 1);
    removed += 1;
    blowing.push({ cx: CENTER_X, cy: v.cy, kind: seg.kind, w: seg.w, color: seg.color, pattern: seg.pattern, cracks: seg.cracks, hits: seg.hits, maxHp: seg.maxHp, id: seg.id, age: 0 });
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

    impacts.push({ x: CENTER_X, y: v.cy, age: 0, dur: 420, size: 130, color: WA.kin });
    spawnSparks(CENTER_X, v.cy, 20);
    spawnShards(CENTER_X, v.cy, [seg.color, '#8a5a2b', WA.shiro], 18, 150);
    shake(260, 12);
    sound.blow();
    replayPause = Math.max(replayPause, BLOW_PAUSE_MS);

    if (!segments.length) {
      // 最後の段。だるまは画面の上端の外（足元 y = -30）から台へ 500 落ちてくる（留まり BLOW_MS ＋ 落下 FALL_MS）。着地したら最終段階（本体を殴る）へ
      phase = 'finish';
      phaseTimer = 0;
      for (const p of projectiles) p.alive = false;
    }
  }

  // 最終段階に入る。だるまは台の上から飛来物を投げ続け、時間停止中は本体にも拳を予約できる
  function enterFinale() {
    if (finale) return;
    finale = true;
    darumaHits = 0;
    daruma.dispDy = 0;
    daruma.vel = 0;
    banner = { text: '本体を殴れ', age: 0, color: WA.ai, dur: 1300 };
    endTurn();
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

  // 着地。巨大な段が 500 落ちてくる重さに釣り合うよう、揺れと土煙は大きく（落下を FALL_MS = 300 に速めたぶん揺れを強めている）。だるまの着地（big）はさらに大きく
  function onLand(o, isDaruma) {
    const big = isDaruma && phase === 'finish';
    if (isDaruma) {
      daruma.squash = big ? 0.32 : 0.16;
      const dg = darumaGeom();
      spawnPuffs(dg.cx, dg.bottom, big ? 26 : 6, DARUMA_W * 0.6, big ? 2.4 : 1);
      if (big) {
        impacts.push({ x: dg.cx, y: dg.bottom, age: 0, dur: 360, size: 90, color: WA.kin });
        shake(380, 18);
      }
    } else {
      o.bounce = 1;
      const i = segments.indexOf(o);
      const r = segRect(i);
      spawnPuffs(CENTER_X, r.y + r.h, 22, r.w * 0.5, 2.2);
      shake(380, 16);
      // 導入：一番下の段が台に着いたら導入を終える（上の段とだるまも同時に着いている）
      if (i === 0) finishIntro();
    }
    // 同時に着地する段の音は 1 回にまとめる
    if (clock - lastLandSound > 40 || big) {
      lastLandSound = clock;
      sound.land(big);
    }
    if (big) enterFinale();
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

  // だるま本体の耐久が尽きた。破片を散らして本体を消し、勝ちの演出へ
  function killDaruma() {
    darumaAlive = false;
    const dg = darumaGeom();
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random());
      const sp = 5 + Math.random() * 12;
      shards.push({
        x: dg.cx + Math.cos(a) * r * (DARUMA_W / 2),
        y: dg.cy + Math.sin(a) * r * (dg.artH / 2),
        vx: Math.cos(a) * sp + (Math.random() - 0.5) * 4,
        vy: Math.sin(a) * sp - 6 - Math.random() * 6,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 0.5,
        age: 0,
        dur: 1600 + Math.random() * 900,
        color: ['#c8311c', '#c8311c', '#fffcf5', WA.kin, WA.sumi][Math.floor(Math.random() * 5)],
        w: 8 + Math.random() * 20,
        h: 6 + Math.random() * 14,
      });
    }
    startWin();
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
    banner = { text: '砕いた', age: 0, color: WA.shu };
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
  // だるま本体は最終段階（段が全部なくなって台に落ちた後）だけ予約できる。段が残っている間に見えているだるまを叩くと、
  // 予約は入らず「拳が届かない」空振りの反応だけ出る。何もない所は予約しない。
  // 画面の外（塔の上の、まだ降りていない段など）はクリックできない。実入力とテスト用フックの両方がここを通る
  function handleClick(x, y) {
    if (phase !== 'timestop') return null;
    if (x < 0 || x >= W || y < 0 || y >= H) return null;
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
      marks.push({ x, y, kind: 'seg' });
      sound.mark();
      return 'seg';
    }
    if (darumaAlive) {
      const dg = darumaGeom();
      if (enemyView.inside(x - dg.cx, y - dg.cy)) {
        if (finale && !segments.length) {
          queue.push({ type: 'daruma', x, y });
          marks.push({ x, y, kind: 'daruma' });
          sound.mark();
          return 'daruma';
        }
        // まだ段の上にいるだるま：拳は届かない。予約もしない（連打しても増えない）。
        // だるまが画面の外にいる間は、画面内の点が絵の中に入らないのでここには来ない
        startWhiff(x, y, dg.bottom);
        return 'whiff';
      }
    }
    return null;
  }

  // 届かない拳。クリック点に近い側の手が伸び、だるまの足元の手前（塔の上あたり）で止まって消える。
  // 時間停止中に動くので lastPunch（再生の拳）とは別に持ち、残像は出さない
  function startWhiff(x, y, darumaBottom) {
    const hand = Math.abs(x - FIST_REST[0].x) <= Math.abs(x - FIST_REST[1].x) ? 0 : 1;
    const rest = FIST_REST[hand];
    const stopY = darumaBottom + WHIFF_GAP;
    // 手元からクリック点へ向かう直線の上で、stopY の高さまでの割合。クリック点が足元に近いときも必ず手前で止める
    const reach = clamp((rest.y - stopY) / Math.max(1, rest.y - y), 0.35, 0.8);
    whiffs[hand] = { tx: x, ty: y, reach, start: clock };
    sound.whiff();
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
  // 土煙：足元の線 (x ± spread, y) から左右へ広がる。size で粒の大きさ・速さ・持ち時間をまとめて大きくする
  function spawnPuffs(x, y, n, spread, size) {
    const k = size || 1;
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      const ox = (0.5 + Math.random() * 0.5) * spread * side;
      puffs.push({
        x: x + ox,
        y: y - 2 - Math.random() * 4 * k,
        vx: side * (1.2 + Math.random() * 2.2) * k,
        vy: -(0.4 + Math.random() * 0.9) * k,
        r: (5 + Math.random() * 6) * k,
        grow: 0.5 * k,
        age: 0,
        dur: (380 + Math.random() * 220) * (0.6 + 0.4 * k),
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
      p.r += p.grow * f;
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
    if (banner) {
      banner.age += dt;
      if (banner.dur && banner.age > banner.dur) banner = null; // 期限つきの見出し（最終段階の合図）は消す
    }
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

    if (phase === 'intro') {
      // 塔が上から落ちてくる（留まり INTRO_HOLD_MS ＋ 落下 FALL_MS）。通常は一番下の段の着地（onLand）で終わる
      phaseTimer += dt;
      if (phaseTimer > INTRO_HOLD_MS + FALL_MS + 1500) finishIntro(); // 保険
    } else if (phase === 'between') {
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
      // だるまが画面の外から台へ落ちてくる（宙に留まる BLOW_MS ＋ 落下 FALL_MS ≒ 0.65 秒）。通常は着地（onLand）で最終段階に入る
      phaseTimer += dt;
      if (phaseTimer > BLOW_MS + FALL_MS + 1500) enterFinale(); // 保険
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

  // 拳の位置と大きさ。alpha は届かない拳が消えていくときだけ 1 未満になる
  function fistPose(hand) {
    const rest = FIST_REST[hand];
    const wf = whiffs[hand];
    if (wf) {
      const e = clock - wf.start;
      if (e < WHIFF_MS) {
        // 伸び切ったら戻らず、その場で薄れて消える
        const out = e < WHIFF_OUT_MS ? easeOut(e / WHIFF_OUT_MS) : 1;
        const t = out * wf.reach;
        const alpha = e < WHIFF_OUT_MS ? 1 : 1 - (e - WHIFF_OUT_MS) / (WHIFF_MS - WHIFF_OUT_MS);
        return { x: lerp(rest.x, wf.tx, t), y: lerp(rest.y, wf.ty, t), s: 1 - 0.4 * t, alpha, moving: false };
      }
      whiffs[hand] = null;
    }
    const p = lastPunch[hand];
    if (!p) return { x: rest.x, y: rest.y, s: 1, alpha: 1, moving: false };
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
    return { x: lerp(rest.x, p.tx, t), y: lerp(rest.y, p.ty, t), s: 1 - 0.4 * t, alpha: 1, moving };
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
    // 塔の影（天板の上）。一番下の段がまだ落ちてくる途中なら、近づくにつれて影が広がる（導入で「上から来る」合図になる）。
    // 一番下の段の幅に合わせて少し広く、接地の ∪ の弧（中央で約 10px 下がる）の周りに覗く厚みにする。太い段（700）でも天板の外には出さない
    if (phase !== 'title') {
      let sw = segments.length ? Math.min(segments[0].w * 0.56, TABLE_W / 2 - 8) : DARUMA_W * 0.5;
      if (segments.length && segments[0].dispDy < 0) sw *= clamp(1 + segments[0].dispDy / SEG_H, 0.3, 1);
      ctx.fillStyle = 'rgba(42, 37, 34, 0.22)';
      ctx.beginPath();
      ctx.ellipse(CENTER_X, TABLE_Y + 2, sw, segments.length ? 9 : 6, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- 丸太（輪切り）の幾何。R はその段の半径（幅 / 2）で、段ごとに違う ----
  // 高さ y にある輪切りの縁（円）の見かけの膨らみ。正 = 上に膨らむ ∩（水平線より上の円を見上げる）、負 = 下に膨らむ ∪（水平線より下）。
  // 膨らみ = 水平線からの距離 ÷ 1000 × 半径、上限は半径の 0.35 倍。基準の幅 620 では静止時の下端（y=470）で約 10px、落下開始時（下端 y≈0）で約 108px
  function arcBulge(y, R) {
    const max = R * ARC_RATIO;
    return clamp(((HORIZON_Y - y) / 1000) * R, -max, max);
  }
  // 縁の弧の、x の位置での y（弧の両端は y、中央は y - bulge）
  function arcY(x, y, bulge, R) {
    const u = clamp(x / R, -1, 1);
    return y - bulge * Math.sqrt(1 - u * u);
  }
  // 現在のパス位置（弧の端）から、高さ y の縁の弧を反対の端まで辿る（楕円の半分）
  function traceArc(ctx, R, y, bulge, leftToRight) {
    const ry = Math.max(0.01, Math.abs(bulge));
    const up = bulge >= 0;
    if (leftToRight) ctx.ellipse(0, y, R, ry, 0, Math.PI, up ? TAU : 0, !up);
    else ctx.ellipse(0, y, R, ry, 0, 0, up ? -Math.PI : Math.PI, up);
  }
  // 段の側面の輪郭（中心を原点）。左右は垂直、上端と下端は縁の弧。角丸は使わない（円柱の縁と側面が出合う角は鋭い）
  function segOutline(ctx, R, bt, bb) {
    ctx.beginPath();
    ctx.moveTo(-R, -SEG_H / 2);
    traceArc(ctx, R, -SEG_H / 2, bt, true);
    ctx.lineTo(R, SEG_H / 2);
    traceArc(ctx, R, SEG_H / 2, bb, false);
    ctx.closePath();
  }
  function edgeArcPath(ctx, R, y, bulge) {
    ctx.beginPath();
    ctx.moveTo(-R, y);
    traceArc(ctx, R, y, bulge, true);
  }

  // 中心線 pts（y が単調増加の折れ線）に沿って幅 2×halfW の帯を塗る。taperStart / taperEnd の端は 18px かけて細く消える
  function fillRibbon(ctx, pts, halfW, taperStart, taperEnd) {
    const n = pts.length;
    if (n < 2) return;
    const taper = 18;
    const ya = pts[0].y;
    const yb = pts[n - 1].y;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      let f = 1;
      if (taperStart) f = Math.min(f, (p.y - ya) / taper);
      if (taperEnd) f = Math.min(f, (yb - p.y) / taper);
      const hw = halfW * Math.max(0.05, Math.min(1, f));
      if (i === 0) ctx.moveTo(p.x - hw, p.y);
      else ctx.lineTo(p.x - hw, p.y);
    }
    for (let i = n - 1; i >= 0; i--) {
      const p = pts[i];
      let f = 1;
      if (taperStart) f = Math.min(f, (p.y - ya) / taper);
      if (taperEnd) f = Math.min(f, (yb - p.y) / taper);
      const hw = halfW * Math.max(0.05, Math.min(1, f));
      ctx.lineTo(p.x + hw, p.y);
    }
    ctx.closePath();
    ctx.fill();
  }

  // 樹皮の静的な模様を描く（段の中心を原点。範囲は x ∈ [-pat.R, pat.R]、y ∈ [-SEG_H/2 - LOG_TEX_EXT, SEG_H/2 + LOG_TEX_EXT]）。
  // 順番：ベース → 色むら → 左右の円柱陰影 → 副筋 → 主筋 → 剥がれ → 節 → 苔 → 点描。年輪は側面には描かない（枝の切り株だけ）
  function drawBarkTexture(ctx, pat) {
    const R = pat.R;
    const w = pat.w;
    const h = SEG_H;
    const y0 = -h / 2 - LOG_TEX_EXT;
    const th = h + 2 * LOG_TEX_EXT;
    ctx.fillStyle = pat.base;
    ctx.fillRect(-R, y0, w, th);
    // 低周波の色むら：輪郭をぼかした柔らかい縦帯
    for (const b of pat.blotches) {
      const g = ctx.createLinearGradient(b.x - b.w / 2, 0, b.x + b.w / 2, 0);
      const c = b.dark ? LOG_SHADE : LOG_LIGHT;
      g.addColorStop(0, `rgba(${c}, 0)`);
      g.addColorStop(0.5, `rgba(${c}, ${b.alpha})`);
      g.addColorStop(1, `rgba(${c}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(b.x - b.w / 2, y0, b.w, th);
    }
    // 円柱の陰影（左右方向）。光の帯は中央より少し左（光は左上前）。右をより暗く。段ごとに帯の位置を ±3% 揺らす
    const sh = pat.lightShift;
    const grad = ctx.createLinearGradient(-R, 0, R, 0);
    const stop = (f, c, a) => grad.addColorStop(clamp(f + 0.5 + sh, 0, 1), `rgba(${c}, ${a})`);
    grad.addColorStop(0, `rgba(${LOG_SHADE}, 0.42)`);
    stop(-0.3, LOG_SHADE, 0.12);
    stop(-0.12, LOG_LIGHT, 0.18);
    stop(0.05, LOG_LIGHT, 0.06);
    stop(0.3, LOG_SHADE, 0.12);
    stop(0.42, LOG_SHADE, 0.3);
    grad.addColorStop(1, `rgba(${LOG_SHADE}, 0.5)`);
    ctx.fillStyle = grad;
    ctx.fillRect(-R, y0, w, th);
    // 副筋
    for (const s of pat.subs) {
      ctx.fillStyle = `rgba(${s.light ? LOG_BARK_LIGHT : LOG_BARK_DARK}, ${s.alpha})`;
      fillRibbon(ctx, s.pts, s.width / 2, true, true);
    }
    // 主筋：溝として読ませるため、筋の左側に細い明線を添える。途切れの端だけ細く消し、筋そのものの端（模様の端＝縁の弧で切り落とす、合流の先）は細らせない
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of pat.streaks) {
      for (const run of s.runs) {
        const taperStart = run[0].y > s.yMin + 1;
        const taperEnd = run[run.length - 1].y < s.yMax - 1;
        ctx.fillStyle = `rgba(${LOG_BARK_DARK}, ${s.alpha})`;
        fillRibbon(ctx, run, s.width / 2, taperStart, taperEnd);
        ctx.strokeStyle = `rgba(${LOG_BARK_LIGHT}, 0.18)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < run.length; i++) {
          const p = run[i];
          if (i === 0) ctx.moveTo(p.x - s.width / 2 - 0.8, p.y);
          else ctx.lineTo(p.x - s.width / 2 - 0.8, p.y);
        }
        ctx.stroke();
      }
    }
    // 剥がれ：少し明るい縦帯。右側に暗い影線、上下の端は細く割れて尖る
    for (const p of pat.peels) {
      const xa = p.x - p.w / 2;
      const xb = p.x + p.w / 2;
      const ya = p.y - p.h / 2;
      const yb = p.y + p.h / 2;
      ctx.fillStyle = `rgba(${LOG_LIGHT}, 0.12)`;
      ctx.beginPath();
      ctx.moveTo(xa, ya + p.tip);
      ctx.lineTo(xa + p.w * 0.35, ya);
      ctx.lineTo(xb, ya + p.tip * 1.3);
      ctx.lineTo(xb, yb - p.tip * 0.7);
      ctx.lineTo(xb - p.w * 0.4, yb);
      ctx.lineTo(xa, yb - p.tip);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = `rgba(${LOG_SHADE}, 0.4)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xb, ya + p.tip * 1.3);
      ctx.lineTo(xb, yb - p.tip * 0.7);
      ctx.lineTo(xb - p.w * 0.4, yb);
      ctx.stroke();
    }
    // 節
    for (const k of pat.knots) {
      ctx.save();
      ctx.translate(k.x, k.y);
      if (k.kind === 'stump') {
        // 枝の切り株：縁に薄い樹皮の輪、中は淡い木口に芯をずらした年輪。突き出ているので右下に影の三日月、左上に光の縁
        ctx.fillStyle = 'rgba(90, 55, 25, 0.55)';
        ctx.beginPath();
        ctx.arc(0, 0, k.r, 0, TAU);
        ctx.fill();
        ctx.fillStyle = LOG_STUMP_FACE;
        ctx.beginPath();
        ctx.arc(0, 0, k.r * 0.82, 0, TAU);
        ctx.fill();
        const cx = k.pcx * k.r;
        const cy = k.pcy * k.r;
        ctx.strokeStyle = LOG_RING;
        ctx.lineWidth = 1.6;
        for (const f of k.rings) {
          ctx.beginPath();
          ctx.ellipse(cx, cy, f * k.r * 0.82 * (1 - Math.abs(k.pcx)), f * k.r * 0.82 * (1 - Math.abs(k.pcy)), 0, 0, TAU);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(112, 66, 26, 0.7)';
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, TAU);
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, k.r, 0, TAU);
        ctx.clip();
        ctx.fillStyle = `rgba(${LOG_SHADE}, 0.3)`;
        ctx.beginPath();
        ctx.arc(0, 0, k.r, 0, TAU);
        ctx.arc(-0.26 * k.r, -0.26 * k.r, k.r, 0, TAU);
        ctx.fill('evenodd');
        ctx.restore();
        ctx.strokeStyle = `rgba(${LOG_LIGHT}, 0.35)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, k.r - 1, Math.PI * 1.0, Math.PI * 1.7);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(42, 37, 34, 0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, k.r, 0, TAU);
        ctx.stroke();
      } else {
        // 生きた節：縦長のアーモンド形（飛来物と見分けるため円くしない。暗部は幅 26px 以下・alpha 0.5 以下）
        ctx.rotate(k.tilt);
        const almond = (hw, hh) => {
          ctx.beginPath();
          ctx.moveTo(0, -hh);
          ctx.quadraticCurveTo(2 * hw, 0, 0, hh);
          ctx.quadraticCurveTo(-2 * hw, 0, 0, -hh);
          ctx.closePath();
        };
        ctx.fillStyle = 'rgba(60, 36, 14, 0.2)'; // 周囲の淡いにじみ
        almond(k.w * 0.5 * 1.35, k.hgt * 0.5 * 1.25);
        ctx.fill();
        const cw = Math.min(k.w * 0.62, 26);
        ctx.fillStyle = 'rgba(50, 30, 12, 0.48)';
        almond(cw / 2, k.hgt * 0.5 * 0.9);
        ctx.fill();
        // 同心の輪
        ctx.lineWidth = 1.6;
        for (let i = 1; i <= k.rings; i++) {
          const f = 0.45 + (0.55 * i) / k.rings;
          ctx.strokeStyle = i % 2 ? 'rgba(230, 200, 150, 0.42)' : 'rgba(50, 30, 12, 0.3)';
          almond((k.w / 2) * f, (k.hgt / 2) * f);
          ctx.stroke();
        }
        // 中心の暗い芽
        ctx.fillStyle = 'rgba(36, 22, 10, 0.85)';
        ctx.beginPath();
        ctx.ellipse(0, 0, 3, 7, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    // 苔
    for (const m of pat.moss) {
      ctx.fillStyle = `rgba(${LOG_MOSS}, ${m.alpha})`;
      ctx.beginPath();
      ctx.ellipse(m.x, m.y, m.rx, m.ry, 0, 0, TAU);
      ctx.fill();
    }
    // 点描（ざらつき）：暗・明半々。数は段の幅に比例させる（基準の幅 620 で 480〜540）
    const srng = mulberry32(pat.stippleSeed);
    const n = Math.round((480 + Math.floor(srng() * 60)) * (w / SEG_W));
    for (let i = 0; i < n; i++) {
      const x = -R + srng() * w;
      const y = y0 + srng() * th;
      ctx.fillStyle = srng() < 0.5 ? `rgba(${LOG_SHADE}, 0.07)` : `rgba(${LOG_LIGHT}, 0.07)`;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
  }

  // 模様を焼いたオフスクリーン canvas を返す（解像度が変わったら焼き直す）。毎フレーム描くのはこのビットマップと縁・影・ヒビだけ
  function barkTexture(pat) {
    const k = Math.min(viewK, 3);
    if (pat.tex && pat.texK === k) return pat.tex;
    const c = pat.tex || document.createElement('canvas');
    const w = pat.w;
    const th = SEG_H + 2 * LOG_TEX_EXT;
    c.width = Math.max(1, Math.ceil(w * k));
    c.height = Math.max(1, Math.ceil(th * k));
    const tctx = c.getContext('2d');
    tctx.setTransform(k, 0, 0, k, (w / 2) * k, (th / 2) * k);
    drawBarkTexture(tctx, pat);
    pat.tex = c;
    pat.texK = k;
    return c;
  }

  // 段のヒビ（段の中心を原点、clip の中で呼ぶ）。段階：0 = 薄い、1 = 中、2 = 大（打数の割合で決まる）。
  // 巨大な段の全面で読めるよう太く長く描く。樹皮の筋（幅 5 以下・alpha 0.3 以下・滑らかな縦）と紛れないよう、ヒビは太く濃く角張ったまま。
  // yTop / hh は段階 1 以上で全体を暗くする範囲（輪郭のはみ出しも覆う）
  function drawSegCracks(ctx, seg, yTop, hh) {
    if (!seg.cracks.length) return;
    const w = seg.w;
    const stage = stageOf(Math.min(seg.hits, seg.maxHp - 1), seg.maxHp);
    const lenMul = [0.45, 0.8, 1.2][stage];
    const lw = [3.5, 5.5, 8][stage];
    const alpha = [0.55, 0.9, 1][stage];
    const off = lw * 0.3; // 明るい線の添え方（割れ目の片側）
    if (stage >= 1) {
      ctx.fillStyle = `rgba(0, 0, 0, ${0.07 * stage})`;
      ctx.fillRect(-w / 2, yTop, w, hh);
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
        ctx.moveTo(cr.x - off, cr.y - off);
        for (const p of br) ctx.lineTo(cr.x + p.x * lenMul - off, cr.y + p.y * lenMul - off);
        ctx.strokeStyle = `rgba(255, 244, 226, ${0.45 * alpha})`;
        ctx.lineWidth = lw * 0.4;
        ctx.stroke();
      }
    }
  }

  // 落下中の段の底面（木口）。段の中心を原点、下端 y = SEG_H/2 を中心にした横幅いっぱいの楕円（縦半径 bb = 下端の弧の膨らみ）。
  // 影の中なので暗い茶に薄い年輪。着地に近づくほど潰れて消える。側面より先に描き、下の段の側面がこの上に重なる
  function drawLogFace(ctx, pat, bb) {
    const R = pat.R;
    const y = SEG_H / 2;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, y, R, bb, 0, 0, TAU);
    ctx.fillStyle = pat.base;
    ctx.fill();
    ctx.fillStyle = LOG_FACE;
    ctx.fill();
    ctx.clip();
    const cx = pat.faceOff * R;
    ctx.strokeStyle = 'rgba(220, 180, 120, 0.18)';
    ctx.lineWidth = 2;
    for (const f of pat.faceRings) {
      ctx.beginPath();
      ctx.ellipse(cx, y, f * (R - Math.abs(cx)), f * bb, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(220, 180, 120, 0.25)';
    ctx.beginPath();
    ctx.ellipse(cx, y, 4, Math.max(0.3, bb * 0.06), 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 5;
    ctx.strokeStyle = WA.sumi;
    ctx.beginPath();
    ctx.ellipse(0, y, R, bb, 0, 0, TAU);
    ctx.stroke();
  }

  // 脆い段＝縦に立つ丸太の側面（段の中心を原点）。bt / bb は上端・下端の弧の膨らみ。
  // 焼いた模様を輪郭で切り抜き、その上に上の段が落とす暗がり・接地の影・切り縁の帯・縁の欠け・ヒビを描き、墨の輪郭で締める
  function drawLogSide(ctx, seg, bt, bb) {
    const w = seg.w;
    const R = w / 2;
    const h = SEG_H;
    const ext = LOG_TEX_EXT;
    if (!seg.pattern) seg.pattern = makeLogPattern(hash3(seg.id || 0, 0, 977), w, null); // 保険（通常は生成時のものを使う）
    const pat = seg.pattern;
    segOutline(ctx, R, bt, bb);
    ctx.save();
    ctx.clip();
    ctx.drawImage(barkTexture(pat), -R, -h / 2 - ext, w, h + 2 * ext);
    // 上の段が落とす暗がり：上端から 70px まで 0.35 → 0（静止時は 40px だけ画面に見え、「上に何かある」合図になる）。弧のはみ出し分も暗く
    let g = ctx.createLinearGradient(0, -h / 2, 0, -h / 2 + 70);
    g.addColorStop(0, `rgba(${LOG_SHADE}, 0.35)`);
    g.addColorStop(1, `rgba(${LOG_SHADE}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-R, -h / 2 - ext, w, 70 + ext);
    // 接地の影：下端から 28px まで 0.30 → 0
    g = ctx.createLinearGradient(0, h / 2 - 28, 0, h / 2);
    g.addColorStop(0, `rgba(${LOG_SHADE}, 0)`);
    g.addColorStop(1, `rgba(${LOG_SHADE}, 0.3)`);
    ctx.fillStyle = g;
    ctx.fillRect(-R, h / 2 - 28, w, 28 + ext);
    // 切り縁の帯：弧に沿って 3px の明るい木色と、その内側に 2px の暗線（木口を見せずに「切った」と伝える）
    ctx.lineCap = 'butt';
    for (const [y, b, dir] of [
      [-h / 2, bt, 1],
      [h / 2, bb, -1],
    ]) {
      ctx.strokeStyle = LOG_EDGE_LIGHT;
      ctx.lineWidth = 3;
      edgeArcPath(ctx, R, y + dir * 1.5, b);
      ctx.stroke();
      ctx.strokeStyle = LOG_EDGE_DARK;
      ctx.lineWidth = 2;
      edgeArcPath(ctx, R, y + dir * 4, b);
      ctx.stroke();
    }
    // 縁から垂れる欠け：鋸で切ったときに樹皮が欠けた表現（淡い木色の半楕円）
    ctx.fillStyle = 'rgba(226, 199, 150, 0.8)';
    for (const c of pat.chips) {
      const ay = c.top ? arcY(c.x, -h / 2, bt, R) : arcY(c.x, h / 2, bb, R);
      ctx.beginPath();
      if (c.top) ctx.ellipse(c.x, ay, c.w / 2, c.d, 0, 0, Math.PI);
      else ctx.ellipse(c.x, ay, c.w / 2, c.d, 0, Math.PI, TAU);
      ctx.fill();
    }
    drawSegCracks(ctx, seg, -h / 2 - ext, h + 2 * ext);
    ctx.restore();
    ctx.lineWidth = 5;
    ctx.strokeStyle = WA.sumi;
    segOutline(ctx, R, bt, bb);
    ctx.stroke();
  }

  // 硬い段＝暗い石に金属の帯（段の中心を原点。見た目は従来のまま、角丸の長方形。幅はその段の w）
  function drawStoneBody(ctx, seg) {
    const w = seg.w;
    const h = SEG_H;
    const corner = 16;
    ctx.lineWidth = 5;
    ctx.strokeStyle = WA.sumi;
    ctx.fillStyle = seg.color;
    roundRect(ctx, -w / 2, -h / 2, w, h, corner);
    ctx.fill();
    ctx.save();
    ctx.clip();
    // 上面の光と下の影
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(-w / 2, -h / 2, w, 22);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(-w / 2, h / 2 - 20, w, 20);
    // 石の肌：まばらな暗い斑
    ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
    for (let i = 0; i < 24; i++) {
      const sx = -w / 2 + 40 + ((i * 197) % (w - 80));
      const sy = -h / 2 + 50 + ((i * 131) % (h - 100));
      ctx.beginPath();
      ctx.ellipse(sx, sy, 18 + (i % 3) * 6, 8 + (i % 2) * 4, (i * 0.7) % 1, 0, TAU);
      ctx.fill();
    }
    // 金属の帯：上下に 2 本、鋲を打つ
    for (const by of [-h / 2 + 44, h / 2 - 44]) {
      ctx.fillStyle = HARD_BAND;
      ctx.fillRect(-w / 2, by - 13, w, 26);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fillRect(-w / 2, by - 13, w, 7);
      ctx.strokeStyle = 'rgba(42, 37, 34, 0.7)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(-w / 2, by - 13, w, 26);
      ctx.fillStyle = WA.sumi;
      for (let rx = -w / 2 + 40; rx < w / 2 - 20; rx += 64) {
        ctx.beginPath();
        ctx.arc(rx, by, 5.5, 0, TAU);
        ctx.fill();
      }
    }
    drawSegCracks(ctx, seg, -h / 2, h);
    ctx.restore();
    ctx.lineWidth = 5;
    ctx.strokeStyle = WA.sumi;
    roundRect(ctx, -w / 2, -h / 2, w, h, corner);
    ctx.stroke();
  }

  // 段の本体。中心を原点に描く。seg は { kind, w, color, pattern, cracks, hits, maxHp } を持つ。
  // topY / bottomY は段の上端・下端の画面上の高さ（縮みや回転をかける前の値）。脆い段の縁の弧の膨らみをこれと段の半径で決める
  function drawSegmentBody(ctx, seg, topY, bottomY) {
    if (seg.kind === 'hard') {
      drawStoneBody(ctx, seg);
      return;
    }
    const R = seg.w / 2;
    drawLogSide(ctx, seg, arcBulge(topY, R), arcBulge(bottomY, R));
  }

  // 奥へ吹っ飛ぶ段：一点（CENTER_X, VANISH_Y）へ縮みながら上がって消える。塔より奥に描く。
  // 巨大な段なので、出だしは勢いよく縮み、終わりは小さな点になって消える（二段の ease で奥行きを強める）
  function drawBlowing(ctx) {
    for (const b of blowing) {
      const t = clamp(b.age / BLOW_MS, 0, 1);
      const e = easeOut(t);
      const sc = lerp(1, 0.05, easeOut(e));
      const y = lerp(b.cy, VANISH_Y, e);
      ctx.save();
      ctx.globalAlpha = 1 - t * t;
      ctx.translate(b.cx, y);
      ctx.rotate((b.id % 2 ? 1 : -1) * 0.45 * t);
      ctx.scale(sc, sc);
      // 輪郭の弧は吹っ飛ぶ前の高さのまま（回転・縮小するだけで新しい面は見せない）
      drawSegmentBody(ctx, b, b.cy - SEG_H / 2, b.cy + SEG_H / 2);
      ctx.restore();
    }
  }

  function drawTower(ctx, k) {
    const stopped = phase === 'timestop';
    // 落下中で下に隙間のある脆い段は、下端が水平線より上にある間だけ底面（木口）が下から覗く。
    // 側面より先に描いておき、下の段（または落下先の段）の側面がこの上に重なるようにする（手前の縁が奥の底面を隠す向き）
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.kind === 'hard' || s.dispDy >= 0) continue;
      if (i > 0 && segments[i - 1].dispDy <= s.dispDy + 0.5) continue; // 下の段と一緒に落ちている（隙間なし）
      const v = segVisual(i);
      const bottomY = v.cy + SEG_H / 2;
      const bb = arcBulge(bottomY, s.w / 2);
      if (bb <= 0.5 || bottomY + bb + 8 < 0) continue;
      ctx.save();
      ctx.translate(v.cx, v.cy);
      drawLogFace(ctx, s.pattern, bb);
      ctx.restore();
    }
    for (let i = 0; i < segments.length; i++) {
      const v = segVisual(i);
      const topY = v.cy - SEG_H / 2;
      const bottomY = v.cy + SEG_H / 2;
      if (bottomY + ARC_MAX + 8 < 0) continue; // 画面の上端より外にある段は描かない（並びは segments のまま保つ。縁の弧のはみ出し分を見込む）
      // 着地の縮み：下端を支点に横へ少し潰れる（重い塊が落ちた手触り。跳ねはしない）
      const sq = 0.05 * Math.sin(Math.PI * segments[i].bounce);
      ctx.save();
      ctx.translate(v.cx, v.cy + SEG_H / 2);
      ctx.scale(1 + sq, 1 - sq);
      ctx.translate(0, -SEG_H / 2);
      drawSegmentBody(ctx, segments[i], topY, bottomY);
      ctx.restore();
    }
    // 敵だるま。足元を支点に傾き・前のめり・着地の縮み。破裂したら描かない
    if (!darumaAlive) return;
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
        // 段・本体への予約：クリックした位置に小さな衝撃の星だけ。数字は出さない
        ctx.save();
        ctx.translate(m.x, m.y);
        ctx.fillStyle = WA.shu;
        ctx.strokeStyle = WA.shiro;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < 16; i++) {
          const a = (i * TAU) / 16 - Math.PI / 2;
          const rr = i % 2 ? 4.5 : 10;
          if (i) ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
          else ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
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
    // 期限つきの見出しは終わりの 300ms で消えていく
    const fade = banner.dur ? clamp((banner.dur - banner.age) / 300, 0, 1) : 1;
    ctx.save();
    ctx.translate(W / 2, H / 2 - 20);
    ctx.rotate(-0.06);
    ctx.scale(pop, pop);
    ctx.globalAlpha = t * fade;
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
    viewK = k;
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
      if (f.alpha > 0) drawFist(ctx, hand, f.x, f.y, f.s, f.alpha);
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
          ? `${turn} 回で砕いた。被弾 ${playerHits}`
          : `${turn} 回目に砕けた。吹っ飛ばした段 ${removed}${finale ? `、本体に ${darumaHits} 打` : ''}`;
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
          return { x: r.x, y: r.y, w: r.w, h: r.h, kind: s.kind, hp: s.hp, maxHp: s.maxHp };
        }),
        darumaRect: darumaRect(),
        removed,
        finale,
        darumaHp: finale ? DARUMA_HP - darumaHits : null,
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
