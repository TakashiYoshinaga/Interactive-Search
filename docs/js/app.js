/**
 * 状態と結線。
 *
 * 守る不変条件は2つだけ:
 *  1. graph と layout は読み込んだあと絶対に書き換えない。位置が動くと
 *     「絞り込まれた」という認識が壊れる。
 *  2. 応答は rev が今の値と一致するときだけ state に書く。連打しても
 *     古い結果が後から上書きしないので、デバウンスは要らない。
 */

import * as L from './ladder.js';
import * as DB from './db.js';
import { computeLayout, positionsToArrays, bakedFits } from './layout.js';
import { computeVisual, createAnim } from './anim.js';
import { createTheme, applyTheme, storedTheme, currentTheme } from './theme.js';
import { createScreens } from './screens.js';
import { createPanel, toast as showToast } from './panel.js';
import { t, setLang, getLang, storedLang, applyToDom, onLangChange } from './i18n.js';

const $ = (id) => document.getElementById(id);

const state = {
  phase: 'splash',
  conn: null,
  graph: null,      // 読み込み後は不変
  layout: null,     // 読み込み後は不変
  schema: [],
  ladder: [],
  rev: 0,
  result: { rev: -1, cypher: '', rungs: [], litNodes: null, litEdges: null,
            paths: 0, ms: 0, running: false, error: null },
  cands: { rev: -1, rows: [], running: false, error: null },
  hoverEid: null,
  view: { mode: '2d', cam2: null, cam3: null },
};

let anim = null;
let view = null;
let theme = null;
let screens = null;
let panel = null;
let raf = 0;
let lastFrame = 0;

// ── rAF。落ち着いたら止める（ノート PC のバッテリーのため） ──────────────────

function tick(now) {
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
  lastFrame = now;
  const settled = anim.step(dt);
  view.frame(dt, anim.cur);
  if (!settled || view.isCameraMoving()) raf = requestAnimationFrame(tick);
  else { raf = 0; lastFrame = 0; }
}

function kick() {
  if (!raf && view && anim) raf = requestAnimationFrame(tick);
}

// ── ラダー ──────────────────────────────────────────────────────────────────

/** ピン留めされている段を、実際のノードの elementId に解決する。 */
function pinnedEids() {
  const out = new Set();
  if (!state.graph) return out;
  for (const step of state.ladder) {
    if (!L.isRung(step) || !step.pin) continue;
    const idx = state.graph.idxByKey.get(String(step.pin.value));
    if (idx !== undefined) out.add(state.graph.nodes[idx].eid);
  }
  return out;
}

function refreshVisual() {
  if (!anim || !state.graph) return;
  const result = state.result.cypher
    ? { cypher: state.result.cypher, litNodes: state.result.litNodes, litEdges: state.result.litEdges }
    : null;
  anim.setTargets(computeVisual(state.graph, result, state.hoverEid, pinnedEids()));
  kick();
}

function renderPanel() {
  panel.render({
    ladder: state.ladder,
    schema: state.schema,
    labels: state.graph ? state.graph.labels : [],
    labelTotals: state.graph ? state.graph.labelTotals : {},
    rungs: state.result.rungs,
    cands: state.cands,
    result: state.result,
    hoverEid: state.hoverEid,
    theme,
  });
}

/**
 * すべてのラダー操作はここに集まる。
 * 同期の描画を先に済ませてから問い合わせる。Cypher バーとラダーが 0ms で
 * 反応するので、往復に 200ms かかっても手応えが遅く感じない。
 */
function submit() {
  const rev = ++state.rev;
  const cypher = state.ladder.length ? L.toCypher(state.ladder) : '';

  state.result = { ...state.result, rev, cypher, running: !!cypher, error: null };
  state.cands = { ...state.cands, rev, running: !!cypher, error: null };
  if (!cypher) {
    state.result = { rev, cypher: '', rungs: [], litNodes: null, litEdges: null,
                     paths: 0, ms: 0, running: false, error: null };
    state.cands = { rev, rows: [], running: false, error: null };
    renderPanel();
    refreshVisual();
    return;
  }
  renderPanel();
  refreshVisual();

  const lookahead = L.lookaheadCypher(state.ladder);
  const conn = state.conn;
  // 先読みが落ちても評価結果は描く。allSettled にするのはそのため
  Promise.allSettled([
    conn.query(cypher),
    lookahead ? conn.query(lookahead) : Promise.resolve(null),
  ]).then(([ev, ca]) => {
    if (rev !== state.rev) return;   // 古い応答は捨てる

    if (ev.status === 'fulfilled') {
      const parsed = L.parseEvaluate(ev.value.records, L.rungCount(state.ladder));
      state.result = {
        rev, cypher,
        rungs: parsed.rungs.map((r, i) => ({
          label: state.ladder[i * 2].label,
          count: r.count, names: r.names, eids: r.eids,
        })),
        litNodes: parsed.litNodes,
        litEdges: parsed.litEdges,
        paths: parsed.paths,
        ms: ev.value.ms,
        running: false, error: null,
      };
    } else {
      state.result = { ...state.result, running: false,
                       error: DB.classifyError(ev.reason) };
      notifyError(state.result.error);
    }

    if (ca.status === 'fulfilled' && ca.value) {
      state.cands = {
        rev,
        rows: L.parseLookahead(ca.value.records, state.schema,
                               L.lastLabel(state.ladder), DB.asNum),
        running: false, error: null,
      };
    } else if (ca.status === 'rejected') {
      state.cands = { ...state.cands, running: false, error: DB.classifyError(ca.reason) };
    } else {
      state.cands = { rev, rows: [], running: false, error: null };
    }

    renderPanel();
    refreshVisual();
  });
}

function notifyError(err) {
  if (!err) return;
  if (err.kind === 'unreachable' || err.kind === 'paused') {
    // 接続そのものが切れたら画面ごと切り替える
    screens.show('fatal', { kind: err.kind, detail: err.detail });
    document.getElementById('app').hidden = true;
    return;
  }
  showToast($('toast'), t(`error.${err.kind}.short`) || err.detail, 'warn');
}

const handlers = {
  onStart(label) {
    state.ladder = L.startWith(label);
    submit();
  },
  onAppend(cand) {
    if (!cand || cand.nodes === 0) return;
    if (L.rungCount(state.ladder) >= L.MAX_RUNGS) {
      showToast($('toast'), t('toast.tooLong', { max: L.MAX_RUNGS }), 'warn');
      return;
    }
    state.ladder = L.append(state.ladder, cand);
    submit();
  },
  onCycleHops(i) {
    state.ladder = L.cycleHops(state.ladder, i);
    submit();
  },
  onTruncate(i) {
    state.ladder = L.truncate(state.ladder, i);
    submit();
  },
  onUnpin(i) {
    state.ladder = L.setPin(state.ladder, i, null);
    submit();
  },
  onClear() {
    state.ladder = L.clear();
    submit();
  },
  onResultHover(eid) {
    state.hoverEid = eid;
    refreshVisual();
    renderPanel();
  },
  onResultClick(eid) {
    const idx = state.graph.idxByEid.get(eid);
    if (idx !== undefined) { view.focusNode(idx); kick(); }
  },
  onCopyCypher() {
    const text = state.result.cypher;
    if (!text || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(
      () => showToast($('toast'), t('toast.copied'), 'info'),
      () => showToast($('toast'), t('toast.copyFailed'), 'warn')
    );
  },
};

/** グラフのノードをクリックしたら末尾の段をそれに固定する（もう一度で解除）。 */
function pinNode(node) {
  if (!node) return;
  if (!node.keyProp) {
    showToast($('toast'), t('toast.pinNoKey'), 'warn');
    return;
  }
  let next = state.ladder;
  if (next.length === 0) next = L.startWith(node.label);
  const tail = L.lastLabel(next);
  if (tail !== node.label) {
    showToast($('toast'), t('toast.pinLabel', { label: tail, got: node.label }), 'warn');
    return;   // rev を進めないしクエリも投げない
  }
  state.ladder = L.togglePinOnLast(next, { prop: node.keyProp, value: node.keyValue });
  submit();
}

// ── ビュー ──────────────────────────────────────────────────────────────────

function wireView(v) {
  v.on('needsframe', kick);
  v.on('nodehover', (node) => {
    state.hoverEid = node ? node.eid : null;
    refreshVisual();
    renderPanel();
  });
  v.on('nodeclick', pinNode);
  v.on('bgclick', () => {});
}

async function setViewMode(mode) {
  if (!view || mode === state.view.mode) return;
  const camKey = state.view.mode === '3d' ? 'cam3' : 'cam2';
  state.view[camKey] = view.getCameraState();
  view.destroy();

  const mod = mode === '3d'
    ? await import('./view3d.js')      // three は 3D に切り替えたときだけ読み込む
    : await import('./view2d.js');
  view = mod.createView($('graph-host'), { theme });
  view.setGraph(state.graph, state.layout);
  const saved = state.view[mode === '3d' ? 'cam3' : 'cam2'];
  if (saved) view.setCameraState(saved);
  wireView(view);
  state.view.mode = mode;

  for (const btn of document.querySelectorAll('[data-view]')) {
    btn.classList.toggle('is-active', btn.dataset.view === mode);
  }
  // anim.cur は作り直さない。切り替えの最中のフェードがそのまま続く
  kick();
}

// ── 起動 ────────────────────────────────────────────────────────────────────

async function boot(cred) {
  screens.show('connecting');
  const started = Date.now();
  let conn;
  try {
    conn = await DB.connect(cred);
  } catch (err) {
    const info = DB.classifyError(err, { elapsedMs: err.elapsedMs || (Date.now() - started) });
    if (info.kind === 'auth' || info.kind === 'ratelimit') {
      screens.show('login', { error: info });
    } else {
      screens.show('fatal', { kind: info.kind, detail: info.detail });
    }
    return;
  }

  if (state.conn) await state.conn.close();   // 作り直す前に必ず閉じる
  state.conn = conn;

  let pre;
  try {
    pre = await DB.precheck(conn);
  } catch (err) {
    screens.show('fatal', DB.classifyError(err));
    return;
  }
  screens.show('precheck', pre);
  if (pre.verdict === 'empty' || pre.verdict === 'toolarge') return;
}

async function enterApp() {
  screens.show('connecting');
  const conn = state.conn;
  const [graph, schema] = await Promise.all([DB.loadGraph(conn), DB.loadSchema(conn)]);
  state.graph = graph;
  state.schema = schema;

  // 位置は焼いたものがあれば使う。同じデータなら講師の画面と受講者の画面が同じ絵になる
  const ids = graph.nodes.map((n) => ({ id: n.key, label: n.label }));
  const links = graph.edges.map((e) => ({
    from: graph.nodes[e.fromIdx] && graph.nodes[e.fromIdx].key,
    to: graph.nodes[e.toIdx] && graph.nodes[e.toIdx].key,
  }));
  let positions = null;
  let source = 'computed';
  if (graph.keysUnique) {
    try {
      const baked = await fetch('./data/layout.json').then((r) => (r.ok ? r.json() : null));
      if (baked && bakedFits(baked, ids)) { positions = baked.positions; source = 'baked'; }
    } catch { /* 焼いたものが無くても計算すればよい */ }
  }
  if (!positions) positions = computeLayout(ids, links);
  state.layout = { ...positionsToArrays(ids, positions), source };

  theme = createTheme(graph.labels, graph.labelTotals);
  anim = createAnim(graph.nodes.length, graph.edges.length);
  const mod = await import('./view2d.js');
  view = mod.createView($('graph-host'), { theme });
  view.setGraph(graph, state.layout);
  wireView(view);

  panel = createPanel({
    ladderRows: $('ladder-rows'), candRows: $('cand-rows'), candFoot: $('cand-foot'),
    resultRows: $('result-rows'), cypherCode: $('cypher-code'), cypherStats: $('cypher-stats'),
    copyBtn: $('btn-copy-cypher'), toast: $('toast'), topbarStatus: $('topbar-status'),
  }, handlers);

  $('topbar-status').textContent =
    `${graph.nodes.length} nodes · ${graph.edges.length} rels · layout: ${source}`;

  screens.hide();
  $('app').hidden = false;
  state.phase = 'ready';
  anim.snap();
  renderPanel();
  refreshVisual();
}

async function disconnect() {
  if (state.conn) { await state.conn.close(); state.conn = null; }
  if (view) { view.destroy(); view = null; }
  if (panel) { panel.destroy(); panel = null; }
  state.graph = null; state.layout = null; state.ladder = []; state.rev = 0;
  state.result = { rev: -1, cypher: '', rungs: [], litNodes: null, litEdges: null,
                   paths: 0, ms: 0, running: false, error: null };
  state.cands = { rev: -1, rows: [], running: false, error: null };
  $('app').hidden = true;
  screens.show('login');
}

// ── 画面まわりの結線 ────────────────────────────────────────────────────────

function wireTopbar() {
  for (const btn of document.querySelectorAll('[data-view]')) {
    btn.addEventListener('click', () => setViewMode(btn.dataset.view));
  }
  for (const btn of document.querySelectorAll('[data-lang]')) {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  }
  $('btn-theme').addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    if (state.graph) {
      theme = createTheme(state.graph.labels, state.graph.labelTotals);
      if (view) view.setTheme(theme);
      renderPanel();
      kick();
    }
  });
  $('btn-reset-view').addEventListener('click', () => { if (view) { view.resetCamera(); kick(); } });
  $('btn-disconnect').addEventListener('click', disconnect);
}

function syncLangButtons() {
  const lang = getLang();
  document.documentElement.lang = lang;
  for (const btn of document.querySelectorAll('[data-lang]')) {
    btn.classList.toggle('is-active', btn.dataset.lang === lang);
  }
}

function main() {
  applyTheme(storedTheme());
  setLang(storedLang());
  applyToDom(document);
  syncLangButtons();
  onLangChange(() => {
    applyToDom(document);
    syncLangButtons();
    if (panel) renderPanel();
  });

  screens = createScreens($('screens'), {
    onStart: () => screens.show('prereq'),
    onPrereqDone: () => screens.show('login'),
    onBack: () => screens.show(state.phase === 'ready' ? 'login' : 'splash'),
    onLogin: (cred) => {
      const v = DB.validateUri(cred.uri);
      if (!v.ok) {
        screens.show('fatal', { kind: 'badscheme', detail: v.reason });
        return;
      }
      boot({ uri: cred.uri.trim(), user: (cred.user || '').trim() || v.derivedUser,
             password: cred.password });
    },
    onCancelConnect: () => screens.show('login'),
    onPrecheckProceed: () => enterApp().catch((err) => {
      screens.show('fatal', DB.classifyError(err));
    }),
    onPrecheckRetry: () => screens.show('prereq'),
    onFatalRetry: () => screens.show('login'),
  });

  wireTopbar();

  // file:// で開くと ES Modules が不透明な CORS エラーで死ぬ。先に説明する
  if (location.protocol === 'file:') {
    screens.show('fatal', { kind: 'fileprotocol', detail: location.href });
    return;
  }
  screens.show('splash');
}

window.addEventListener('pagehide', () => { if (state.conn) state.conn.close(); });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}
