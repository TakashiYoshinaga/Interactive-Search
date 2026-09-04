/**
 * 左のラダー・候補、右の結果一覧、下の Cypher バー。
 *
 * このモジュールは DOM を組むだけで、状態も DB も持たない。app.js から
 * render(state) を呼ばれるたびに「今の state に対する正しい画面」を作る。
 *
 * 行の文字列は原典（VR 版）の見た目をそのまま踏襲している:
 *
 *     (:Engineer)  ★ payment-gateway            29 / 30
 *       -[:RESPONDED_TO]->                          ×1
 *
 * 件数が「29 / 30」なのが肝で、右の 30 が「DB にある Engineer の総数」。
 * 絞り込みが進むほど左が減る、という関係が常に見えている必要がある。
 *
 * 候補は **0 件のものも消さずに出す**（無効化して見せる）。押す前に行き止まりが
 * 見えることが先読み機能の実体なので、0 件を隠すとこの機能は死ぬ。
 *
 * DB 由来の文字列（ラベル名・リレーション型・ノード名・エラーメッセージ）は
 * すべて textContent で入れる。innerHTML は使わない。
 */

import { t, getLang } from './i18n.js';
import { isRung, rungCount, MAX_RUNGS } from './ladder.js';

const TOAST_MS = 2400;
const toastTimers = new WeakMap();

// ── 小道具 ──────────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** ラベルの色玉。色は theme.js が CSS 変数から作ったものを使う（JS に色を持たない）。 */
function dot(theme, label) {
  const node = el('span', 'dot');
  const color = theme && theme.forLabel ? theme.forLabel(label).color : '';
  if (color) node.style.background = color;
  return node;
}

function hopsChip(hops) {
  const [lo, hi] = hops || [1, 1];
  return lo === hi ? `×${lo}` : `×${lo}..${hi}`;
}

/** 段の見出し。ラベルは DB 由来なので訳さない。 */
function rungPattern(label) {
  return `(:${label})`;
}

function edgePattern(rel) {
  return `-[:${rel}]->`;
}

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const key = `fatal.${error.kind || 'unknown'}.title`;
  const translated = t(key);
  return translated === key ? String(error.detail || t('fatal.unknown.title')) : translated;
}

function errorSig(error) {
  return error && typeof error === 'object'
    ? JSON.stringify({ kind: error.kind, code: error.code, detail: error.detail })
    : String(error || '');
}

/** 再描画で焦点が飛ぶとキーボード操作が続けられない。
 *  data-fk（focus key）で同じ行を探し直して戻す。 */
function keepFocus(container, paint) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.getAttribute('data-fk') : null;
  paint();
  if (!key) return;
  const back = container.querySelector(`[data-fk="${CSS.escape(key)}"]`);
  if (back && !back.disabled) {
    try { back.focus({ preventScroll: true }); } catch { back.focus(); }
  }
}

// ── トースト ────────────────────────────────────────────────────────────────

/** 一瞬だけ出るメッセージ。UI は塞がない。 */
export function toast(elm, message, kind = 'info') {
  if (!elm) return;
  elm.textContent = String(message);
  elm.className = `toast toast--${kind === 'warn' ? 'warn' : 'info'}`;
  elm.hidden = false;
  clearTimeout(toastTimers.get(elm));
  toastTimers.set(elm, setTimeout(() => { elm.hidden = true; }, TOAST_MS));
}

// ── 本体 ────────────────────────────────────────────────────────────────────

export function createPanel(refs, handlers = {}) {
  const call = (name, arg) => {
    const fn = handlers[name];
    if (typeof fn === 'function') fn(arg);
  };

  const {
    ladderRows, candRows, candFoot, resultRows,
    cypherCode, cypherStats, copyBtn, topbarStatus,
  } = refs;

  // eid -> その eid を指す結果行。ホバーの付け外しだけ全体の描き直しを避ける
  let nameByEid = new Map();
  let sig = { ladder: '', cand: '', result: '', cypher: '', status: '' };
  let lastHover = null;

  // ── ラダー ────────────────────────────────────────────────────────────
  function paintLadder(state) {
    const { ladder = [], rungs = [], labelTotals = {}, theme } = state;
    ladderRows.replaceChildren();

    if (!ladder.length) {
      ladderRows.append(el('p', 'hint', t('ladder.empty')));
      return;
    }

    ladder.forEach((step, i) => {
      if (isRung(step)) {
        const k = i / 2;
        const row = el('div', 'row row--rung');

        // 行全体が「ここまで戻す」。::after で行いっぱいに広げてあるので、
        // ピンのボタンだけが上に乗る（入れ子の button にしない）
        const main = el('button', 'row__main');
        main.type = 'button';
        main.setAttribute('data-fk', `rung:${i}`);
        main.title = t('ladder.truncate');
        main.append(dot(theme, step.label), el('span', 'row__pat', rungPattern(step.label)));
        main.addEventListener('click', () => call('onTruncate', i));
        row.append(main);

        if (step.pin && step.pin.value !== undefined && step.pin.value !== null) {
          const pin = el('button', 'row__pin');
          pin.type = 'button';
          pin.setAttribute('data-fk', `pin:${i}`);
          pin.title = t('ladder.unpin');
          pin.append(el('span', 'row__star', '★'),
                     el('span', 'row__pinval', String(step.pin.value)));
          pin.addEventListener('click', () => call('onUnpin', i));
          row.append(pin);
        }

        const total = labelTotals[step.label];
        const got = rungs[k] ? String(rungs[k].count) : '—';
        const count = el('span', 'row__count', `${got} / ${total === undefined ? '—' : total}`);
        if (!rungs[k]) count.classList.add('is-stale');
        row.append(count);
        ladderRows.append(row);
      } else {
        const btn = el('button', 'row row--edge');
        btn.type = 'button';
        btn.setAttribute('data-fk', `edge:${i}`);
        btn.title = t('ladder.hops');
        btn.append(el('span', 'row__pat', edgePattern(step.rel)),
                   el('span', 'chip', hopsChip(step.hops)));
        btn.addEventListener('click', () => call('onCycleHops', i));
        ladderRows.append(btn);
      }
    });
  }

  // ── 候補 ──────────────────────────────────────────────────────────────
  function paintCands(state) {
    const { ladder = [], cands = {}, labels = [], labelTotals = {}, theme } = state;
    candRows.replaceChildren();
    candFoot.replaceChildren();

    // ラダーが空のときは「起点のラベルを選ぶ」画面になる
    if (!ladder.length) {
      for (const label of labels) {
        const btn = el('button', 'cand');
        btn.type = 'button';
        btn.setAttribute('data-fk', `start:${label}`);
        const head = el('span', 'cand__pat');
        head.append(dot(theme, label),
                    el('span', 'cand__txt', t('cand.start', { pattern: rungPattern(label) })));
        btn.append(head, el('span', 'cand__num', String(labelTotals[label] ?? '')));
        btn.addEventListener('click', () => call('onStart', label));
        candRows.append(btn);
      }
      if (!labels.length) candRows.append(el('p', 'hint', t('cand.none')));
      return;
    }

    if (cands.error) {
      const box = el('p', 'hint hint--err');
      box.append(el('span', null, t('cand.error')), el('span', 'hint__raw', errorText(cands.error)));
      candRows.append(box);
    }

    const full = rungCount(ladder) >= MAX_RUNGS;
    const rows = cands.rows || [];

    for (const cand of rows) {
      const btn = el('button', 'cand');
      btn.type = 'button';
      btn.setAttribute('data-fk', `cand:${cand.rel}:${cand.label}`);
      const dead = !cand.nodes;
      // 0 件でも消さない。押す前に行き止まりが見えることが先読みの中身
      btn.disabled = dead || full;
      btn.classList.toggle('is-dead', dead);

      // 辺と段を別の span にしておくと、幅が足りないときに
      // 「-[:X]-> の後ろ」で折れる。パターンの途中では折らせない
      const pat = el('span', 'cand__pat');
      pat.append(dot(theme, cand.label),
                 el('span', 'cand__rel', edgePattern(cand.rel)),
                 el('span', 'cand__lab', rungPattern(cand.label)));
      const num = el('span', 'cand__num',
        dead ? t('cand.dead') : t('cand.stats', { nodes: cand.nodes, edges: cand.edges }));
      btn.append(pat, num);
      btn.addEventListener('click', () => call('onAppend', cand));
      candRows.append(btn);
    }

    if (!rows.length && !cands.error) {
      candRows.append(el('p', 'hint', cands.running ? t('cand.running') : t('cand.none')));
    }
    if (full) candFoot.append(el('p', 'hint', t('cand.max', { n: MAX_RUNGS })));

    const clear = el('button', 'ghost-btn ghost-btn--wide', t('cand.clear'));
    clear.type = 'button';
    clear.setAttribute('data-fk', 'clear');
    clear.addEventListener('click', () => call('onClear'));
    candFoot.append(clear);
  }

  // ── 結果 ──────────────────────────────────────────────────────────────
  function paintResults(state) {
    const { ladder = [], rungs = [], result = {}, theme } = state;
    resultRows.replaceChildren();
    nameByEid = new Map();

    if (result.error) {
      const box = el('p', 'hint hint--err');
      box.append(el('span', null, t('results.error')), el('span', 'hint__raw', errorText(result.error)));
      resultRows.append(box);
    }

    if (!ladder.length || !rungs.length) {
      if (!result.error) {
        resultRows.append(el('p', 'hint', result.running ? t('results.running') : t('results.empty')));
      }
      return;
    }

    rungs.forEach((rung, k) => {
      const step = ladder[k * 2];
      if (!step) return;
      const grp = el('details', 'grp');
      grp.open = true;

      const head = document.createElement('summary');
      head.className = 'grp__head';
      head.append(
        el('span', 'grp__var', `r${k}`),
        dot(theme, step.label),
        el('span', 'grp__label', `:${step.label}`),
        el('span', 'grp__count', String(rung.count))
      );
      grp.append(head);

      const list = el('div', 'grp__body');
      const eids = rung.eids || [];
      (rung.names || []).forEach((name, idx) => {
        const eid = eids[idx];
        const btn = el('button', 'name');
        btn.type = 'button';
        btn.setAttribute('data-fk', `name:${k}:${eid ?? idx}`);
        // ノード名は DB 由来。textContent 以外で入れない
        btn.textContent = name === null || name === undefined || name === ''
          ? t('results.unnamed') : String(name);
        if (eid !== undefined) {
          btn.dataset.eid = eid;
          if (!nameByEid.has(eid)) nameByEid.set(eid, []);
          nameByEid.get(eid).push(btn);
        }
        btn.addEventListener('mouseenter', () => call('onResultHover', eid ?? null));
        btn.addEventListener('mouseleave', () => call('onResultHover', null));
        btn.addEventListener('focus', () => call('onResultHover', eid ?? null));
        btn.addEventListener('blur', () => call('onResultHover', null));
        btn.addEventListener('click', () => call('onResultClick', eid ?? null));
        list.append(btn);
      });
      grp.append(list);
      resultRows.append(grp);
    });
  }

  // ── Cypher バー ───────────────────────────────────────────────────────
  function paintCypher(state) {
    const { result = {} } = state;
    const hasCypher = !!result.cypher;
    // 生成した Cypher。表示された文字列がそのまま実行されている必要があるので加工しない
    cypherCode.textContent = hasCypher ? result.cypher : t('cypher.empty');
    cypherCode.classList.toggle('is-empty', !hasCypher);

    cypherStats.replaceChildren();
    if (result.error) {
      cypherStats.append(el('span', 'stats-err', t('cypher.error')));
    } else if (result.paths === undefined || result.paths === null) {
      cypherStats.append(el('span', null, result.running ? t('cypher.running') : ''));
    } else {
      cypherStats.append(el('span', null,
        t('cypher.stats', { paths: result.paths, ms: Math.round(result.ms ?? 0) })));
    }
    if (copyBtn) copyBtn.disabled = !hasCypher;
  }

  // ── topbar の状態表示 ─────────────────────────────────────────────────
  function paintStatus(state) {
    if (!topbarStatus) return;
    const { labels = [], labelTotals = {} } = state;
    const nodes = labels.reduce((sum, l) => sum + (labelTotals[l] || 0), 0);
    topbarStatus.textContent = labels.length
      ? t('app.status', { nodes, labels: labels.length }) : '';
  }

  // ── ホバー ────────────────────────────────────────────────────────────
  function paintHover(hoverEid) {
    if (lastHover === hoverEid) return;
    for (const list of nameByEid.values()) {
      for (const btn of list) btn.classList.remove('is-hover');
    }
    const hit = hoverEid === null || hoverEid === undefined ? null : nameByEid.get(hoverEid);
    if (hit) for (const btn of hit) btn.classList.add('is-hover');
    lastHover = hoverEid;
  }

  // ── 描き直しの判定 ────────────────────────────────────────────────────
  // 毎回全部組み直すとホバーがちらつくので、変わった区画だけ作り直す。
  function render(state = {}) {
    const s = {
      ladder: [], schema: [], labels: [], labelTotals: {},
      rungs: [], cands: {}, result: {}, hoverEid: null, theme: null, ...state,
    };
    const lang = getLang();

    const next = {
      ladder: JSON.stringify([lang, s.ladder, s.rungs.map((r) => r.count), s.labelTotals]),
      cand: JSON.stringify([lang, s.ladder.length, s.labels, s.labelTotals,
                            s.cands.rows, errorSig(s.cands.error),
                            !!s.cands.running]),
      result: JSON.stringify([lang, s.ladder.map((x) => x.label ?? null),
                              s.rungs, errorSig(s.result.error),
                              !!s.result.running]),
      cypher: JSON.stringify([lang, s.result.cypher ?? null, s.result.paths ?? null,
                              s.result.ms ?? null, !!s.result.running,
                              errorSig(s.result.error)]),
      status: JSON.stringify([lang, s.labels, s.labelTotals]),
    };

    if (next.ladder !== sig.ladder) keepFocus(ladderRows, () => paintLadder(s));
    if (next.cand !== sig.cand) keepFocus(candRows, () => paintCands(s));
    if (next.result !== sig.result) {
      keepFocus(resultRows, () => paintResults(s));
      lastHover = null;
    }
    if (next.cypher !== sig.cypher) paintCypher(s);
    if (next.status !== sig.status) paintStatus(s);
    sig = next;

    // 実行中は数字を消さずに薄くするだけ。UI は塞がない
    ladderRows.classList.toggle('is-stale', !!s.result.running);
    resultRows.classList.toggle('is-stale', !!s.result.running);
    candRows.classList.toggle('is-stale', !!s.cands.running);
    cypherStats.classList.toggle('is-stale', !!s.result.running);

    paintHover(s.hoverEid);
  }

  function onCopy() { call('onCopyCypher'); }
  if (copyBtn) copyBtn.addEventListener('click', onCopy);

  return {
    render,
    destroy() {
      if (copyBtn) copyBtn.removeEventListener('click', onCopy);
      // 行のリスナは行ごと捨てるので個別に外す必要はない
      for (const node of [ladderRows, candRows, candFoot, resultRows, cypherStats]) {
        if (node) node.replaceChildren();
      }
      if (cypherCode) cypherCode.textContent = '';
      if (topbarStatus) topbarStatus.textContent = '';
      nameByEid = new Map();
      sig = { ladder: '', cand: '', result: '', cypher: '', status: '' };
    },
  };
}
