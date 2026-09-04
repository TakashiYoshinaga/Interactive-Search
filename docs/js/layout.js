/**
 * グラフの配置を1回だけ計算して凍結する。決定論的でなければならない。
 *
 * 「同じノードが同じ場所にある」が崩れると「絞り込まれた」という認識が壊れる。
 * これは性能の話ではなく認知の話で、このツールで最も重要な要件。
 * 教室では講師の投影画面と受講者の画面が同じ絵になることにも効く。
 *
 * 2D と 3D は「1回の計算」から作る。別々に回すと 2D↔3D の切り替えで全ノードが
 * ワープして上の要件が壊れるので、x, y は両者でビット一致させ、3D は z を足すだけにする。
 *
 * ── 決定論のための規則（破ると機械ごとに絵が変わる） ──
 *  1. ノードと辺はバイト単位比較でソートしてから流す。localeCompare は使わない。
 *  2. 乱数は mulberry32（32bit 整数演算のみ）。
 *  3. 反復ループの中で Math.pow / exp / sin / cos を使わない。IEEE-754 でビット指定
 *     されておらずエンジン間で差が出る。+ - * / と Math.sqrt は正確。
 *     冷却は有理式にし、円周上の定数はループ外で1回だけ計算して 1e-6 に丸める。
 *
 * このモジュールは純関数だけ。DOM もグローバルも副作用も持たない。
 */

const ITER = 400;
const T0 = 0.10;          // 初期温度（1ステップの最大変位）
const COOL = 20;          // 冷却の強さ。t = T0 * ITER / (ITER + COOL * it)
const ANCHOR_R = 0.55;    // 初期配置でラベルごとの種を置く円の半径
const ANCHOR_K = 0.03;    // アンカーへ引き戻す弱いバネ（発散防止程度）
const CENTER_K = 0.004;   // 中心への微引力

// ラベルごとの塊を分ける。
// 力学の中でアンカーのバネを強くしても辺の引力に勝てず毛玉のままになるので
// （実測: 引力は同じ距離でアンカーの5倍以上）、力学が終わってから
// 「塊ごと平行移動する」という後処理で分ける。内部の有機的な形はそのまま残る。
// ラベルはソート順に円周へ並ぶ。NordWind では Engineer / Incident / Service / Team の
// 順になり、schema の連鎖（Engineer->Incident->Service<-Team）と一致するので
// 5種類の辺がすべて「円周上で隣り合う塊どうし」を結ぶ形になる。
const SEPARATION = 0.9;    // 塊の重心を置く円の半径
const GROUP_BLEND = 0.65;  // 重心をアンカーへどれだけ寄せるか
const GROUP_SHRINK = 0.88; // 塊の内部の広がりをどれだけ縮めるか
const DEOVERLAP_PASSES = 12;
const DEOVERLAP_CAP = 0.05;   // 重なり解消で動かしてよい上限（正規化半径に対する比）
const Z_DEPTH = 0.35;         // 3D の層の厚み
const Z_JITTER = 0.22;
const PERCENTILE = 0.98;      // 外れ値1個で全体が縮まないように

// 間隔決めのためだけの大きさの目安（描画サイズそのものではない）。opts.sizes で上書きできる
const DEFAULT_SIZES = { Team: 14, Service: 8, Incident: 6, Engineer: 4 };
const DEFAULT_SIZE = 6;
const R_SCALE = 1 / 260;      // 上の数値を正規化空間の半径に落とす係数
const CHAR_W = 0.011;         // ラベル1文字あたりのおおよその幅（正規化空間）
const LABEL_PAD = 0.02;

// ── 決定論のための小道具 ────────────────────────────────────────────────────

/** バイト単位の比較。localeCompare はロケールで結果が変わるので使わない。 */
export function byteCompare(a, b) {
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** 黄金角の螺旋。初期配置と z のジッタに使う。ループ外で1回だけ作って丸める。 */
const GOLDEN = (() => {
  const N = 256;
  const GA = 2.399963229728653; // 黄金角
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    const r = Math.sqrt((i + 0.5) / N);
    out[i] = [round6(r * Math.cos(GA * i)), round6(r * Math.sin(GA * i))];
  }
  return out;
})();

/** ラベルを単位円上に等間隔で置く。 */
function anchorsFor(count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count;
    out[i] = [round6(Math.cos(a)), round6(Math.sin(a))];
  }
  return out;
}

/** FNV-1a。グラフが baked レイアウトと同じものかを判定する。 */
export function graphSignature(nodes, edges) {
  const parts = [
    ...nodes.map((n) => `${n.id}${n.label || ''}`).sort(byteCompare),
    '',
    ...edges.map((e) => `${e.from}${e.to}`).sort(byteCompare),
  ];
  let h = 0x811c9dc5;
  const s = parts.join('');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + ':' + nodes.length + ':' + edges.length;
}

// ── 本体 ────────────────────────────────────────────────────────────────────

/**
 * @param nodes [{id, label}]  id は呼び出し側が一意性を保証する文字列（アプリは key を渡す）
 * @param edges [{from, to}]   from / to はノードの id
 * @returns {{[id: string]: [number, number, number]}}  中心が原点、半径がほぼ 1
 */
export function computeLayout(nodes, edges, opts = {}) {
  const sizes = opts.sizes || DEFAULT_SIZES;
  const n = nodes.length;
  if (n === 0) return {};

  // 1. 入力順で結果が変わるので必ず固定する
  const sorted = [...nodes].sort(
    (a, b) => byteCompare(a.label || '', b.label || '') || byteCompare(a.id, b.id)
  );
  const index = new Map(sorted.map((v, i) => [v.id, i]));
  const labels = [...new Set(sorted.map((v) => v.label || ''))].sort(byteCompare);
  const labelIdx = sorted.map((v) => labels.indexOf(v.label || ''));

  const links = edges
    .map((e) => [index.get(e.from), index.get(e.to)])
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b)
    .sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const anchor = anchorsFor(labels.length);
  const rnd = mulberry32(0x9e3779b9);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  // 2. 初期配置: 自ラベルのアンカー付近に黄金角螺旋で置く。乱数は微小な散らしだけ
  for (let i = 0; i < n; i++) {
    const [ax, ay] = anchor[labelIdx[i]];
    const [gx, gy] = GOLDEN[i % GOLDEN.length];
    const jitter = 1 + 0.3 * rnd();
    x[i] = ax * ANCHOR_R + gx * 0.18 * jitter;
    y[i] = ay * ANCHOR_R + gy * 0.18 * jitter;
  }

  // 3. 力学。K は理想的な辺の長さ
  const K = 1 / Math.sqrt(n);
  const K2 = K * K;
  for (let it = 0; it < ITER; it++) {
    const t = (T0 * ITER) / (ITER + COOL * it);
    dx.fill(0);
    dy.fill(0);

    // 反発 O(n^2)。73 ノードなら 2664 ペアで無料。sqrt も要らない
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ax = x[i] - x[j];
        let ay = y[i] - y[j];
        let d2 = ax * ax + ay * ay;
        if (d2 < 1e-9) { ax = 1e-4; ay = 0; d2 = 1e-8; }
        const f = K2 / d2;
        dx[i] += ax * f; dy[i] += ay * f;
        dx[j] -= ax * f; dy[j] -= ay * f;
      }
    }

    // 辺の引力
    for (let e = 0; e < links.length; e++) {
      const i = links[e][0], j = links[e][1];
      const ax = x[i] - x[j];
      const ay = y[i] - y[j];
      const d = Math.sqrt(ax * ax + ay * ay) || 1e-4;
      const f = d / K;
      dx[i] -= ax * f; dy[i] -= ay * f;
      dx[j] += ax * f; dy[j] += ay * f;
    }

    // ラベルアンカーへの弱いバネ + 中心への微引力（発散防止）。
    // 塊を分けるのはここではなく、力学のあとの後処理でやる
    for (let i = 0; i < n; i++) {
      const [ax, ay] = anchor[labelIdx[i]];
      dx[i] += (ax * ANCHOR_R - x[i]) * ANCHOR_K - x[i] * CENTER_K;
      dy[i] += (ay * ANCHOR_R - y[i]) * ANCHOR_K - y[i] * CENTER_K;
    }

    // 温度でクランプして適用
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (d > 1e-12) {
        const s = (d < t ? d : t) / d;
        x[i] += dx[i] * s;
        y[i] += dy[i] * s;
      }
    }
  }

  // 4. 正規化: 重心を原点へ → 半径の 98 パーセンタイルで割る
  normalize(x, y, n);

  // 5. ラベルごとの塊を丸ごと平行移動して分ける。内部の形は力学の結果のまま残る。
  //    ここが「段を足すと隣の近傍へ歩いていく」という見え方を作っている
  separateGroups(x, y, labelIdx, labels.length, anchor, n);
  normalize(x, y, n);

  // 6. ラベルの重なりを解く。ラベルは横長なので、めり込みの浅い軸へ逃がすと
  //    結果として主に縦にずれる（読める方向）
  const halfW = new Float64Array(n);
  const halfH = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = (sizes[sorted[i].label] || DEFAULT_SIZE) * R_SCALE;
    halfW[i] = Math.max(r, (String(sorted[i].id).length * CHAR_W + LABEL_PAD) / 2);
    halfH[i] = r + 0.016;
  }
  deoverlap(x, y, halfW, halfH, n);
  recenter(x, y, n);

  // 7. z: ラベルごとの浅い層（2.5D）。x, y には一切触らない
  const mid = (labels.length - 1) / 2;
  const out = {};
  for (let i = 0; i < n; i++) {
    const tier = mid === 0 ? 0 : (labelIdx[i] - mid) / mid;
    const z = Z_DEPTH * (tier + Z_JITTER * GOLDEN[i % GOLDEN.length][0]);
    out[sorted[i].id] = [round6(x[i]), round6(y[i]), round6(z)];
  }
  return out;
}

/** ラベルごとの重心をアンカーへ寄せ、内部の広がりを少し縮める。 */
function separateGroups(x, y, labelIdx, m, anchor, n) {
  if (m < 2) return;
  const cx = new Float64Array(m), cy = new Float64Array(m), cnt = new Float64Array(m);
  for (let i = 0; i < n; i++) { const g = labelIdx[i]; cx[g] += x[i]; cy[g] += y[i]; cnt[g]++; }
  for (let g = 0; g < m; g++) if (cnt[g]) { cx[g] /= cnt[g]; cy[g] /= cnt[g]; }
  for (let i = 0; i < n; i++) {
    const g = labelIdx[i];
    const rx = (x[i] - cx[g]) * GROUP_SHRINK;
    const ry = (y[i] - cy[g]) * GROUP_SHRINK;
    const tx = anchor[g][0] * SEPARATION;
    const ty = anchor[g][1] * SEPARATION;
    x[i] = cx[g] + (tx - cx[g]) * GROUP_BLEND + rx;
    y[i] = cy[g] + (ty - cy[g]) * GROUP_BLEND + ry;
  }
}

function normalize(x, y, n) {
  recenter(x, y, n);
  const radii = new Float64Array(n);
  for (let i = 0; i < n; i++) radii[i] = Math.sqrt(x[i] * x[i] + y[i] * y[i]);
  const sortedR = Array.from(radii).sort((a, b) => a - b);
  const r = sortedR[Math.min(n - 1, Math.floor(PERCENTILE * (n - 1)))] || 1;
  for (let i = 0; i < n; i++) { x[i] /= r; y[i] /= r; }
}

function recenter(x, y, n) {
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += x[i]; cy += y[i]; }
  cx /= n; cy /= n;
  for (let i = 0; i < n; i++) { x[i] -= cx; y[i] -= cy; }
}

/** ラベルの箱（横長）が重なっていたら、めり込みの浅い軸へ押し分ける。 */
function deoverlap(x, y, halfW, halfH, n) {
  const x0 = Float64Array.from(x);
  const y0 = Float64Array.from(y);
  for (let pass = 0; pass < DEOVERLAP_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ax = x[i] - x[j];
        const ay = y[i] - y[j];
        const penX = halfW[i] + halfW[j] - Math.abs(ax);
        const penY = halfH[i] + halfH[j] - Math.abs(ay);
        if (penX <= 0 || penY <= 0) continue;
        moved = true;
        if (penY <= penX) {
          const s = (ay >= 0 ? 1 : -1) * penY * 0.5;
          y[i] += s; y[j] -= s;
        } else {
          const s = (ax >= 0 ? 1 : -1) * penX * 0.5;
          x[i] += s; x[j] -= s;
        }
      }
    }
    if (!moved) break;
  }
  // 力学の結果を壊さないよう、元の位置からの総移動量に上限をかける
  for (let i = 0; i < n; i++) {
    const ox = x[i] - x0[i];
    const oy = y[i] - y0[i];
    const d = Math.sqrt(ox * ox + oy * oy);
    if (d > DEOVERLAP_CAP) {
      const s = DEOVERLAP_CAP / d;
      x[i] = x0[i] + ox * s;
      y[i] = y0[i] + oy * s;
    }
  }
}

/**
 * {id: [x,y,z]} を、呼び出し側のノード配列の順に並んだ描画用の配列に落とす。
 * pos2 と pos3 の x, y はビット一致する（2D↔3D でワープさせないため）。
 */
export function positionsToArrays(nodes, pos) {
  const n = nodes.length;
  const pos2 = new Float32Array(n * 2);
  const pos3 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = pos[nodes[i].id] || [0, 0, 0];
    pos2[i * 2] = p[0];
    pos2[i * 2 + 1] = p[1];
    pos3[i * 3] = p[0];
    pos3[i * 3 + 1] = p[1];
    pos3[i * 3 + 2] = p[2];
  }
  return { pos2, pos3 };
}

/** baked が今のグラフに使えるか。全ノードの id が揃っていることが条件。 */
export function bakedFits(baked, nodes) {
  if (!baked || typeof baked !== 'object') return false;
  const pos = baked.positions || baked;
  for (const node of nodes) if (!pos[node.id]) return false;
  return true;
}
