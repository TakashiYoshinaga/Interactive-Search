/**
 * 配色・形・大きさ。色の実体は CSS 変数（css/style.css）にあり、ここはそれを
 * 読んで描画側が使いやすい形に整えるだけ。JS 側に色を二重定義しないこと。
 *
 * ラベルごとの割り当ては「ラベル名」ではなく「ラベルをソートした順番」で決める。
 * どんなスキーマでも動くようにするため。NordWind では Engineer / Incident /
 * Service / Team の順になるので、意図した色と形にそのまま落ちる。
 *
 * 大きさは「珍しいラベルほど大きい」。件数の少ないラベル（Team は8個）が目立ち、
 * 多いラベル（Engineer は30個）が小さくなる。これも名前に依存しない。
 */

const CAT_COUNT = 8;

// index -> 形。色だけに頼らないため（色覚多様性にも効く）
export const SHAPES = ['diamond', 'hexagon', 'roundrect', 'circle',
                       'triangle', 'square', 'pentagon', 'cross'];

const R_MAX = 11;
const R_MIN = 4.5;
const R_EXP = 0.75;   // 件数比をどれだけ大きさに反映するか

const HOT_SCALE = 1.22;
const HOVER_SCALE = 1.35;
const PIN_SCALE = 1.5;

const RAMP_STEPS = 8;   // 減衰↔通常の色を毎フレーム作らず、段階を先に作って添字で引く

function readVars(root = document.documentElement) {
  const cs = getComputedStyle(root);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const num = (name, fallback) => {
    const n = parseFloat(v(name, ''));
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    bg: v('--bg', '#f3f1ec'),
    bgStage: v('--bg-stage', '#efece6'),
    fg: v('--fg', '#2f3338'),
    fgMute: v('--fg-mute', '#6f747a'),
    panel: v('--panel', '#fbfaf7'),
    line: v('--line', '#e0dcd4'),
    hot: v('--hot', '#9a7430'),
    hotSoft: v('--hot-soft', '#c9a45c'),
    dim: v('--dim', '#c3bfb7'),
    edge: v('--edge', '#8c877d'),
    dimAlpha: num('--dim-alpha', 0.38),
    dimScale: num('--dim-scale', 0.45),
    edgeIdleAlpha: num('--edge-idle-alpha', 0.62),
    edgeDimAlpha: num('--edge-dim-alpha', 0.14),
    cats: Array.from({ length: CAT_COUNT }, (_, i) => v(`--cat-${i}`, '#888888')),
  };
}

// ── 色の小道具 ──────────────────────────────────────────────────────────────

/** '#rrggbb' -> [r, g, b] */
export function parseHex(hex) {
  const s = String(hex).trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [136, 136, 136];
}

export function toHex([r, g, b]) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** ラベル名から色相を決める（未知のラベル用）。決定論的。 */
function hashIndex(name) {
  let h = 0x811c9dc5;
  const s = String(name);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % CAT_COUNT;
}

// ── 本体 ────────────────────────────────────────────────────────────────────

/**
 * @param labels ソート済みのラベル一覧
 * @param labelTotals {label: 件数}
 * @returns Theme
 */
export function createTheme(labels, labelTotals = {}) {
  const vars = readVars();
  const counts = labels.map((l) => labelTotals[l] || 1);
  const minCount = Math.min(...counts, 1);

  const dimRGB = parseHex(vars.dim);
  const byLabel = new Map();

  labels.forEach((label, i) => {
    // ソート順が 8 を超えたらハッシュに落とす（衝突しても致命的ではない）
    const slot = i < CAT_COUNT ? i : hashIndex(label);
    const base = parseHex(vars.cats[slot]);
    const count = labelTotals[label] || 1;
    const radius = Math.max(R_MIN, R_MAX * Math.pow(minCount / count, R_EXP));

    // 減衰↔通常の色を先に段階化しておく。毎フレーム hsl() 文字列を組まない
    const ramp = Array.from({ length: RAMP_STEPS }, (_, k) =>
      toHex(mix(dimRGB, base, k / (RAMP_STEPS - 1)))
    );

    byLabel.set(label, {
      label,
      index: i,
      slot,
      color: toHex(base),
      rgb: base,
      ramp,
      shape: SHAPES[slot % SHAPES.length],
      radius,
      pickRadius: Math.max(radius, 9),   // 見た目が縮んでも当たり判定は縮めない
    });
  });

  const fallback = {
    label: '', index: -1, slot: 0,
    color: vars.fgMute, rgb: parseHex(vars.fgMute),
    ramp: Array.from({ length: RAMP_STEPS }, (_, k) =>
      toHex(mix(dimRGB, parseHex(vars.fgMute), k / (RAMP_STEPS - 1)))),
    shape: 'circle', radius: 6, pickRadius: 9,
  };

  return {
    vars,
    labels,
    rampSteps: RAMP_STEPS,
    hotScale: HOT_SCALE,
    hoverScale: HOVER_SCALE,
    pinScale: PIN_SCALE,
    forLabel: (label) => byLabel.get(label) || fallback,
    /** 0（減衰）〜1（通常）を色に落とす。 */
    rampAt: (style, t) =>
      style.ramp[Math.max(0, Math.min(RAMP_STEPS - 1, Math.round(t * (RAMP_STEPS - 1))))],
  };
}

/** 今のテーマ名。 */
export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** テーマを切り替えて localStorage に覚える。認証情報は決して保存しないが、
 *  見た目の好みは覚えてよい。 */
export function applyTheme(name) {
  const value = name === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', value);
  try { localStorage.setItem('gl.theme', value); } catch { /* プライベートウィンドウ等 */ }
  return value;
}

export function storedTheme() {
  try {
    const v = localStorage.getItem('gl.theme');
    if (v === 'dark' || v === 'light') return v;
  } catch { /* 読めなくてもよい */ }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light';
}
