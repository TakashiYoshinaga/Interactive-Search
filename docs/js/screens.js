/**
 * 接続までの画面（splash / prereq / login / connecting / precheck / fatal）。
 *
 * マークアップは index.html の #screens に静的に置いてある。ここがやるのは
 * 「どれを出すか」と「差し込む値」だけ。文言は i18n.js の辞書から取る。
 *
 * この画面群は資格情報を受け取るので、以下を守る:
 *   - 入力値はどこにも保存しない（localStorage / sessionStorage / cookie / URL）。
 *     onLogin に渡して呼び出し側のメモリに置くだけ。
 *   - autocomplete を切る。ブラウザのパスワード保存に載せない。
 *   - #screens を畳むときにパスワード欄を空にする。
 *
 * DB 由来の文字列（ラベル名・リレーション型・ドライバのエラーメッセージ）は
 * すべて textContent で入れる。辞書の文言も innerHTML は通さず、
 * fillRich / fillInline が DOM を組み立てる。
 */

import { t, applyToDom, onLangChange, setLang, getLang, LINKS } from './i18n.js';

const FATAL_KINDS = new Set([
  'auth', 'ratelimit', 'unreachable', 'paused', 'badscheme',
  'timeout', 'toolarge', 'fileprotocol', 'unknown',
]);

const VERDICTS = new Set(['nordwind', 'empty', 'other', 'toolarge']);

// data-act → handlers のキー
const ACTIONS = {
  'start': 'onStart',
  'prereq-done': 'onPrereqDone',
  'back': 'onBack',
  'cancel-connect': 'onCancelConnect',
  'precheck-proceed': 'onPrecheckProceed',
  'precheck-retry': 'onPrecheckRetry',
  'fatal-retry': 'onFatalRetry',
};

// ── 文言の描画 ──────────────────────────────────────────────────────────────

/** 辞書の1行を DOM にする。`...` は <code>、**...** は <strong>。
 *  innerHTML を使わないので、辞書に何が入っていても記号は記号のまま出る。 */
function fillInline(el, text) {
  el.replaceChildren();
  const re = /`([^`]+)`|\*\*([^*]+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) el.append(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const code = document.createElement('code');
      code.textContent = m[1];
      el.append(code);
    } else {
      const strong = document.createElement('strong');
      strong.textContent = m[2];
      el.append(strong);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
}

/** 改行で段落に割る。 */
function fillRich(el, text) {
  el.replaceChildren();
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const p = document.createElement('p');
    fillInline(p, line);
    el.append(p);
  }
}

// ── URI からユーザー名を導く ────────────────────────────────────────────────

/**
 * `neo4j+s://5b75437f.databases.neo4j.io` → `5b75437f`。
 * 現行 Aura ではこれがユーザー名（= インスタンス ID）。ノートブックは `neo4j` を
 * 直書きしているので、ここで拾ってやらないと全員が認証エラーで詰まる。
 * URL コンストラクタは neo4j+s:// を特殊スキームとして扱わないので自前で切る。
 */
export function deriveUser(uri) {
  const m = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^/?#]+)/.exec(String(uri).trim());
  if (!m) return '';
  const host = m[1].split('@').pop().split(':')[0];
  const first = host.split('.')[0];
  return first && first !== host ? first : '';
}

// ── 本体 ────────────────────────────────────────────────────────────────────

export function createScreens(root, handlers = {}) {
  const call = (name, arg) => {
    const fn = handlers[name];
    if (typeof fn === 'function') fn(arg);
  };

  const $ = (sel) => root.querySelector(sel);
  const sections = new Map(
    [...root.querySelectorAll('[data-screen]')].map((el) => [el.dataset.screen, el])
  );

  const form = $('[data-login-form]');
  const inUri = $('#in-uri');
  const inUser = $('#in-user');
  const inPw = $('#in-pw');
  const loginErr = $('[data-login-err]');
  const derived = $('[data-login-derived]');

  let currentName = null;
  let currentData = null;

  // 外部リンクは i18n.js の LINKS を唯一の出所にする（HTML 側は保険の直書き）
  for (const a of root.querySelectorAll('[data-link]')) {
    const href = LINKS[a.dataset.link];
    if (href) a.setAttribute('href', href);
  }

  // ── 言語 ──────────────────────────────────────────────────────────────
  function paintLangButtons() {
    for (const b of root.querySelectorAll('[data-screen-lang]')) {
      b.classList.toggle('is-active', b.dataset.screenLang === getLang());
      b.setAttribute('aria-pressed', String(b.dataset.screenLang === getLang()));
    }
  }

  /** 辞書由来の文言をまとめて描き直す。言語切り替えのたびに呼ぶ。 */
  function paintStatic() {
    applyToDom(root);
    for (const el of root.querySelectorAll('[data-rich]')) fillRich(el, t(el.dataset.rich));
    for (const el of root.querySelectorAll('[data-rich-cell]')) fillInline(el, t(el.dataset.richCell));
    paintLangButtons();
  }

  // ── precheck ──────────────────────────────────────────────────────────
  function paintPrecheck(data = {}) {
    const verdict = VERDICTS.has(data.verdict) ? data.verdict : 'other';

    $('[data-pc="nodes"]').textContent = String(data.nodeCount ?? '—');
    $('[data-pc="rels"]').textContent = String(data.relCount ?? '—');

    // ラベル名も型名も DB から来た文字列。訳さないし、textContent でしか入れない
    const tbody = $('[data-pc="labels"]');
    tbody.replaceChildren();
    for (const row of data.labels || []) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      const dot = document.createElement('span');
      dot.className = 'dot';
      td1.append(dot);
      const name = document.createElement('code');
      name.textContent = String(row.label);
      td1.append(name);
      const td2 = document.createElement('td');
      td2.className = 'num';
      td2.textContent = String(row.count);
      tr.append(td1, td2);
      tbody.append(tr);
    }

    const types = data.relTypes || [];
    $('[data-pc="reltypes"]').textContent = types.length ? types.join(' · ') : '—';

    const notice = $('[data-pc="verdict"]');
    notice.classList.remove('notice--ok', 'notice--warn', 'notice--err');
    notice.classList.add(verdict === 'nordwind' ? 'notice--ok'
                       : verdict === 'empty' ? 'notice--err' : 'notice--warn');
    $('[data-pc="verdict-title"]').textContent = t(`precheck.${verdict}.title`);
    fillRich($('[data-pc="verdict-body"]'), t(`precheck.${verdict}.body`));

    const proceed = $('[data-act="precheck-proceed"]');
    const retry = $('[data-act="precheck-retry"]');
    const back = sections.get('precheck').querySelector('[data-act="back"]');

    proceed.hidden = verdict === 'empty';
    proceed.textContent = t(verdict === 'nordwind' ? 'precheck.proceed' : 'precheck.proceedAnyway');
    retry.hidden = verdict === 'nordwind';
    retry.textContent = t('precheck.recheck');
    back.textContent = t(verdict === 'empty' ? 'precheck.toPrereq' : 'common.back');
  }

  // ── fatal ─────────────────────────────────────────────────────────────
  function paintFatal(data = {}) {
    const kind = FATAL_KINDS.has(data.kind) ? data.kind : 'unknown';
    $('[data-fatal="kind"]').textContent = kind;
    $('[data-fatal="title"]').textContent = t(`fatal.${kind}.title`);
    fillRich($('[data-fatal="body"]'), t(`fatal.${kind}.body`));

    const details = $('[data-fatal="details"]');
    const pre = $('[data-fatal="detail"]');
    const hasDetail = data.detail !== undefined && data.detail !== null && String(data.detail) !== '';
    details.hidden = !hasDetail;
    // ドライバのメッセージ。DB 由来なので textContent
    pre.textContent = hasDetail ? String(data.detail) : '';
  }

  // ── login ─────────────────────────────────────────────────────────────
  function paintLogin(data = {}) {
    const msg = data && data.error;
    loginErr.hidden = !msg;
    loginErr.textContent = msg ? String(msg) : '';
    paintDerived();
  }

  /** URI を打っている最中に、実際に使うユーザー名を見せる。 */
  function paintDerived() {
    const typed = inUser.value.trim();
    const id = typed ? '' : deriveUser(inUri.value);
    if (!id) {
      derived.hidden = true;
      derived.replaceChildren();
      return;
    }
    derived.hidden = false;
    fillInline(derived, t('login.user.derived', { id }));
  }

  function onSubmit(ev) {
    ev.preventDefault();
    const uri = inUri.value.trim();
    const password = inPw.value;
    let user = inUser.value.trim();

    const fail = (key) => {
      loginErr.hidden = false;
      loginErr.textContent = t(key);
    };
    if (!uri) return fail('login.err.uri');
    if (!user) {
      user = deriveUser(uri);
      if (!user) return fail('login.err.derive');
    }
    if (!password) return fail('login.err.password');

    loginErr.hidden = true;
    loginErr.textContent = '';
    call('onLogin', { uri, user, password });
  }

  // ── 出し分け ──────────────────────────────────────────────────────────
  function repaint() {
    if (currentName === 'precheck') paintPrecheck(currentData);
    else if (currentName === 'fatal') paintFatal(currentData);
    else if (currentName === 'login') paintLogin(currentData);
  }

  /** 画面を切り替えたときだけ焦点を移す。同じ画面の描き直しでは動かさない。 */
  function focusFirst(section) {
    const target = section.querySelector('input:not([type="hidden"])')
                || section.querySelector('.btn--primary')
                || section.querySelector('button');
    if (target) {
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
    }
  }

  function show(name, data) {
    const section = sections.get(name);
    if (!section) return;
    const changed = currentName !== name;
    currentName = name;
    currentData = data || null;

    root.hidden = false;
    for (const [key, el] of sections) el.hidden = key !== name;
    repaint();
    if (changed) focusFirst(section);
  }

  function hide() {
    root.hidden = true;
    for (const el of sections.values()) el.hidden = true;
    currentName = null;
    currentData = null;
    // アプリに移ったらパスワードは DOM にも残さない
    inPw.value = '';
  }

  // ── 結線 ──────────────────────────────────────────────────────────────
  function onClick(ev) {
    const langBtn = ev.target.closest('[data-screen-lang]');
    if (langBtn) {
      setLang(langBtn.dataset.screenLang);
      return;
    }
    const actBtn = ev.target.closest('[data-act]');
    if (actBtn && root.contains(actBtn)) call(ACTIONS[actBtn.dataset.act]);
  }

  root.addEventListener('click', onClick);
  form.addEventListener('submit', onSubmit);
  inUri.addEventListener('input', paintDerived);
  inUser.addEventListener('input', paintDerived);

  // 言語が変わったら、静的な文言も今出ている画面の動的な部分も描き直す
  const offLang = onLangChange(() => { paintStatic(); repaint(); });

  paintStatic();

  return {
    show,
    hide,
    destroy() {
      offLang();
      root.removeEventListener('click', onClick);
      form.removeEventListener('submit', onSubmit);
      inUri.removeEventListener('input', paintDerived);
      inUser.removeEventListener('input', paintDerived);
      inPw.value = '';
      hide();
    },
  };
}
