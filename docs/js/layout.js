/**
 * グラフの配置を1回だけ計算して凍結する。決定論的でなければならない。
 *
 * 「同じノードが同じ場所にある」が崩れると「絞り込まれた」という認識が壊れる。
 * これは性能の話ではなく認知の話で、このツールで最も重要な要件。
 * 教室では講師の投影画面と受講者の画面が同じ絵になることにも効く。
 *
 * レイアウトは真3D空間でのフォースシミュレーション（Fruchterman-Reingold 系:
 * 全ペア反発 k²/d² + 辺の引力 d²/k + 弱い中心引力）を固定回数だけ回して凍結する。
 * ラベルごとのアンカー分離もラベル重なり解消もしない。この種のグラフ描画で一般に
 * 使われる力学（d3-force-3d / networkx.spring_layout など）と同じく、
 * 「トポロジが作る形」をそのまま見せるのが目的で、塊は辺の引力によって自然にできる。
 * ラベルの画面空間での衝突処理は view2d.js / view3d.js が既に行っている。
 *
 * 2D と 3D は「1回の計算」から作る。別々に回すと 2D↔3D の切り替えで全ノードが
 * ワープして上の要件が壊れるので、x, y は両者でビット一致させ（2D はこの真3D
 * レイアウトの直交射影）、3D は z を足すだけにする。
 *
 * 座標は Neo4j/Aura に決して保存しない。DB にあるのはトポロジだけで、配置は
 * ここ（と tools/bake-layout.mjs が焼く data/layout.json）で決定的に再生する。
 *
 * ── 決定論のための規則（破ると機械ごとに絵が変わる） ──
 *  1. ノードと辺はバイト単位比較でソートしてから流す。localeCompare は使わない。
 *  2. 乱数は一切使わない。初期配置は球面フィロタキシス螺旋（下 SPHERE）。
 *  3. 反復ループの中で Math.pow / exp / sin / cos を使わない。IEEE-754 でビット指定
 *     されておらずエンジン間で差が出る。+ - * / と Math.sqrt は正確。
 *     ループ外で前計算する定数は round6（1e-6 に丸める）。
 *
 * このモジュールは純関数だけ。DOM もグローバルも副作用も持たない。
 */

const ITER = 400;
const T0 = 0.10;          // 初期温度（1ステップの最大変位）
const COOL = 20;          // 冷却の強さ。t = T0 * ITER / (ITER + COOL * it)
const CENTER_K = 0.004;   // 中心への微引力（発散防止）
const Z_SCALE = 1.0;      // 正規化後に z を掛ける係数。奥行きが効きすぎる場合だけ下げる
                          // （立体視のある環境では 0.6 くらいまで潰すと読みやすくなる）
const PERCENTILE = 0.98;  // 外れ値1個で全体が縮まないように

// 力学レイアウトに「正しい向き」は無い。回転も鏡像もすべて等価な解なので、
// 同じグラフを独立に計算すると、形は揃っても向きが揃わない。
// 実測すると、この題材の見慣れた 3D 表示に対して上下・左右がほぼ反転していた
// （73 ノード全体で測った当てはまりは、この符号なら RMS 0.32、そのままだと 1.11。
//  任意の回転を許したときの下限が 0.19、無相関の目安が 1.41 なので、
//  形そのものは一致していて違いは向きだけだった）。
// 見比べたときに同じ向きに読めるよう、出力時に軸の符号を合わせる。
// 剛体変換なのでレイアウトの品質・決定性・2D と 3D の x, y 共有には影響しない。
const ORIENT = [-1, -1, -1];

// ── 決定論のための小道具 ────────────────────────────────────────────────────

/** バイト単位の比較。localeCompare はロケールで結果が変わるので使わない。 */
export function byteCompare(a, b) {
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * 球面フィロタキシス（フィボナッチ）螺旋の初期配置。乱数なしで、隣り合うインデックスが
 * 球面上を均等に回っていく。ループ外で1回だけ計算し round6 して使う（規則3）。
 * MAX_NODES=2000 を十分カバーするため N=2048。それ以上の n では modulo で回す
 * （実運用に届かない規模だが、初期配置が重複しても力学が解いてくれる）。
 */
const SPHERE = (() => {
  const N = 2048;
  const GA = 2.399963229728653; // 黄金角（ラジアン）
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const a = GA * i;
    out[i] = [round6(r * Math.cos(a)), round6(y), round6(r * Math.sin(a))];
  }
  return out;
})();

/** FNV-1a。グラフが baked レイアウトと同じものかを判定する。 */
export function graphSignature(nodes, edges) {
  const parts = [
    ...nodes.map((n) => `${n.id}|${n.label || ''}`).sort(byteCompare),
    '‡',
    ...edges.map((e) => `${e.from}|${e.to}`).sort(byteCompare),
  ];
  let h = 0x811c9dc5;
  const s = parts.join('');
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
 * @returns {{[id: string]: [number, number, number]}}  中心が原点、半径がほぼ 1 の真3D座標
 */
export function computeLayout(nodes, edges, opts = {}) {
  const n = nodes.length;
  if (n === 0) return {};

  // 1. 入力順で結果が変わるので必ず固定する
  const sorted = [...nodes].sort(
    (a, b) => byteCompare(a.label || '', b.label || '') || byteCompare(a.id, b.id)
  );
  const index = new Map(sorted.map((v, i) => [v.id, i]));

  const links = edges
    .map((e) => [index.get(e.from), index.get(e.to)])
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b)
    .sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const dz = new Float64Array(n);

  // 2. 初期配置: 球面上フィロタキシス（乱数なし）
  for (let i = 0; i < n; i++) {
    const [sx, sy, sz] = SPHERE[i % SPHERE.length];
    x[i] = sx; y[i] = sy; z[i] = sz;
  }

  // 3. 力学。K は理想的な辺の長さ（FR: 反発 k²/d²、引力 d²/k）
  const K = 1 / Math.sqrt(n);
  const K2 = K * K;
  for (let it = 0; it < ITER; it++) {
    const t = (T0 * ITER) / (ITER + COOL * it);
    dx.fill(0);
    dy.fill(0);
    dz.fill(0);

    // 反発 O(n^2)。73 ノードなら 2664 ペアで無料。sqrt も要らない
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ax = x[i] - x[j];
        let ay = y[i] - y[j];
        let az = z[i] - z[j];
        let d2 = ax * ax + ay * ay + az * az;
        if (d2 < 1e-9) { ax = 1e-4; ay = 0; az = 0; d2 = 1e-8; }
        const f = K2 / d2;
        dx[i] += ax * f; dy[i] += ay * f; dz[i] += az * f;
        dx[j] -= ax * f; dy[j] -= ay * f; dz[j] -= az * f;
      }
    }

    // 辺の引力。ax の大きさが d なので、ax * (d/K) で大きさ d²/K になる（FR）
    for (let e = 0; e < links.length; e++) {
      const i = links[e][0], j = links[e][1];
      const ax = x[i] - x[j];
      const ay = y[i] - y[j];
      const az = z[i] - z[j];
      const d = Math.sqrt(ax * ax + ay * ay + az * az) || 1e-4;
      const f = d / K;
      dx[i] -= ax * f; dy[i] -= ay * f; dz[i] -= az * f;
      dx[j] += ax * f; dy[j] += ay * f; dz[j] += az * f;
    }

    // 中心への微引力（発散防止）。塊の分離は力学に任せる
    for (let i = 0; i < n; i++) {
      dx[i] -= x[i] * CENTER_K;
      dy[i] -= y[i] * CENTER_K;
      dz[i] -= z[i] * CENTER_K;
    }

    // 温度でクランプして適用
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i] + dz[i] * dz[i]);
      if (d > 1e-12) {
        const s = (d < t ? d : t) / d;
        x[i] += dx[i] * s;
        y[i] += dy[i] * s;
        z[i] += dz[i] * s;
      }
    }
  }

  // 4. 正規化: 3次元の重心を原点へ → 半径（3D）の 98 パーセンタイルで割る
  normalize(x, y, z, n);
  if (Z_SCALE !== 1) {
    for (let i = 0; i < n; i++) z[i] *= Z_SCALE;
  }

  // 5. 出力。x, y は 2D ビューの射影としてそのまま共有される（不変条件）
  const out = {};
  for (let i = 0; i < n; i++) {
    out[sorted[i].id] = [
      round6(x[i] * ORIENT[0]),
      round6(y[i] * ORIENT[1]),
      round6(z[i] * ORIENT[2]),
    ];
  }
  return out;
}

function normalize(x, y, z, n) {
  recenter(x, y, z, n);
  const radii = new Float64Array(n);
  for (let i = 0; i < n; i++) radii[i] = Math.sqrt(x[i] * x[i] + y[i] * y[i] + z[i] * z[i]);
  const sortedR = Array.from(radii).sort((a, b) => a - b);
  const r = sortedR[Math.min(n - 1, Math.floor(PERCENTILE * (n - 1)))] || 1;
  for (let i = 0; i < n; i++) { x[i] /= r; y[i] /= r; z[i] /= r; }
}

function recenter(x, y, z, n) {
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += x[i]; cy += y[i]; cz += z[i]; }
  cx /= n; cy /= n; cz /= n;
  for (let i = 0; i < n; i++) { x[i] -= cx; y[i] -= cy; z[i] -= cz; }
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
