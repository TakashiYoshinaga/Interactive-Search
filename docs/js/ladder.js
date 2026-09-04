/**
 * ラダー（積み上げたクエリの形）を Cypher に変換し、応答を読み解く。
 *
 * ラダーは平坦な配列で、偶数番目が「段」(label)、奇数番目が「辺」(rel):
 *
 *   [ {label: "Engineer"},
 *     {rel: "RESPONDED_TO", hops: [1, 1]},
 *     {label: "Incident"},
 *     {rel: "AFFECTED", hops: [1, 1]},
 *     {label: "Service"},
 *     {rel: "DEPENDS_ON", hops: [1, 3]},
 *     {label: "Service", pin: {prop: "name", value: "payment-gateway"}} ]
 *
 * 段に変数 r0, r1, ... を振って RETURN するのが肝。r0..rN が段ごとのカウンタ、
 * p が強調用のパス全体（可変長で通過した中間ノードを含む）になる。1往復で両方取れる。
 *
 * このモジュールは純関数だけで書く。DOM もグローバルも副作用も持たないので、
 * ブラウザからも Node からも同じファイルを import できる（tools/verify-ladder.mjs）。
 */

export const MAX_RUNGS = 8;

// ホップ数ダイヤル。辺の行をクリックするたびにこの順で切り替わる
export const HOP_STEPS = [[1, 1], [1, 2], [1, 3]];

// 表示キーに使うプロパティ。この順で最初に見つかったものを採用する。
// Incident には name が無いので id に落ちる
const KEY_PROPS = ['name', 'id'];

const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── 小道具 ──────────────────────────────────────────────────────────────────

/** 段か辺かは label の「有無」ではなく「中身」で判定する。
 *  クライアントが {label: null} を送ってきても辺を段と誤認しないように。 */
export function isRung(step) {
  return !!(step && step.label);
}

export function rungCount(ladder) {
  return Math.floor((ladder.length + 1) / 2);
}

/** 末尾の段のラベル。ラダーが空、または辺で終わっていれば null。 */
export function lastLabel(ladder) {
  if (!ladder.length) return null;
  const last = ladder[ladder.length - 1];
  return isRung(last) ? last.label : null;
}

/** ラベル・リレーション型は DB 由来なので、識別子として不正ならバッククォートで囲む。
 *  NordWind では素のまま (r0:Engineer) になる。 */
export function quoteIdent(s) {
  const str = String(s);
  return BARE_IDENT.test(str) ? str : '`' + str.replace(/`/g, '``') + '`';
}

/** ピンの値をリテラルとして埋め込む。型を見て引用符の要否を決める。 */
export function quoteLiteral(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  // Neo4j の Integer（disableLosslessIntegers を付けていない経路）
  if (v && typeof v.toNumber === 'function') return String(v.toNumber());
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** ノードの表示キー。{prop, value} か null（どちらのプロパティも無いノード）。 */
export function nodeKeyOf(node) {
  const props = (node && node.properties) || {};
  for (const prop of KEY_PROPS) {
    const value = props[prop];
    if (value !== undefined && value !== null && value !== '') {
      return { prop, value: typeof value === 'object' && typeof value.toString === 'function'
        ? value.toString() : value };
    }
  }
  return null;
}

/** 表示キーの文字列だけが欲しいとき。 */
export function nodeKeyString(node) {
  const k = nodeKeyOf(node);
  return k === null ? null : String(k.value);
}

/** 辺の3つ組キー。可変長では同じ辺を複数パスが通るので重複排除に使う。
 *  アプリ本体は relationship の elementId を使うが、受け入れ値の突き合わせ用に
 *  こちらも用意しておく（C1 で両方 24 になることを確認する）。 */
export function edgeTripleKey(startNode, rel, endNode) {
  return `${nodeKeyString(startNode)}|${rel.type}|${nodeKeyString(endNode)}`;
}

/** バイト単位の比較。localeCompare はロケールで結果が変わるので使わない。 */
export function byteCompare(a, b) {
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ── Cypher 生成 ─────────────────────────────────────────────────────────────

/** ラダーをパターン部分（(r0:X)-[:R]->(r1:Y) …）のトークン列にする。 */
function patternTokens(ladder) {
  return ladder.map((step, i) => {
    if (isRung(step)) {
      let pin = '';
      if (step.pin && step.pin.prop && step.pin.value !== undefined && step.pin.value !== null) {
        pin = ` {${quoteIdent(step.pin.prop)}: ${quoteLiteral(step.pin.value)}}`;
      }
      return `(r${Math.floor(i / 2)}:${quoteIdent(step.label)}${pin})`;
    }
    const [lo, hi] = step.hops || [1, 1];
    // [1,1] のときは * を一切出さない。初学者が最初に見る Cypher を綺麗に保つ
    const hops = lo === 1 && hi === 1 ? '' : `*${lo}..${hi}`;
    return `-[:${quoteIdent(step.rel)}${hops}]->`;
  });
}

/** トークン列を読める形に折る。Cypher では改行は無意味なので
 *  「表示されている文字列がそのまま実行される」ことは保たれる。 */
function foldPattern(tokens) {
  const INDENT = '          '; // "MATCH p = " と同じ幅
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    // 2本目以降の辺の手前で折る（1行に「辺 + 段」が1組ずつ並ぶ）
    if (i > 1 && tokens[i].startsWith('-[')) out += '\n' + INDENT;
    out += tokens[i];
  }
  return out;
}

/** ラダー → 実行する Cypher。 */
export function toCypher(ladder) {
  const n = rungCount(ladder);
  const returns = Array.from({ length: n }, (_, k) => `r${k}`).join(', ');
  return `MATCH p = ${foldPattern(patternTokens(ladder))}\nRETURN ${returns}, p`;
}

/**
 * 先読み（候補の件数）を1本で取るクエリ。
 *
 * 素朴に書くと候補ごとにフルクエリを投げることになるが、ブラウザ→Aura は RTT が
 * 150〜250ms あるので、グループ化した1本に置き換えている。末尾段を通過するノード集合は
 * どちらでも同じなので結果も一致する（C1 で N 本版と突き合わせて確認する）。
 *
 * このクエリは 0 件の候補を返さないので、呼び出し側で schema を母集合にして
 * 0 を埋めること（parseLookahead がやる）。0 件の候補を無効化して見せるのが
 * 「先読み提案」の実体なので、ここを省くと機能が死ぬ。
 */
export function lookaheadCypher(ladder) {
  if (!ladder.length || lastLabel(ladder) === null) return null;
  const tail = `r${rungCount(ladder) - 1}`;
  return `MATCH ${foldPattern(patternTokens(ladder))}
WITH DISTINCT ${tail} AS tail
MATCH (tail)-[e]->(nxt)
RETURN type(e) AS rel, labels(nxt)[0] AS label,
       count(DISTINCT nxt) AS nodes, count(DISTINCT e) AS edges`;
}

/** 先読みを候補ごとに1本ずつ投げる素朴な版。等価性の検証にだけ使う。 */
export function lookaheadCypherPerCandidate(ladder, schemaRows) {
  const from = lastLabel(ladder);
  if (from === null) return [];
  return schemaRows
    .filter((row) => row.from === from)
    .map((row) => ({
      rel: row.rel,
      label: row.to,
      cypher: toCypher([...ladder, { rel: row.rel, hops: [1, 1] }, { label: row.to }]),
    }));
}

// ── 応答の読み解き ──────────────────────────────────────────────────────────

/**
 * evaluate の応答 → {rungs, litNodes, litEdges, paths}
 *
 * records は driver の Record の配列（ブラウザ版でも Node 版でも同じ形）。
 * litNodes / litEdges は elementId の集合（同名ノードが潰れないように）。
 */
export function parseEvaluate(records, nRungs) {
  const rungMaps = Array.from({ length: nRungs }, () => new Map()); // eid -> 表示名
  const litNodes = new Set();
  const litEdges = new Set();
  const litEdgeTriples = new Set(); // from|TYPE|to 版（検証用）

  for (const rec of records) {
    for (let i = 0; i < nRungs; i++) {
      const node = rec.get(`r${i}`);
      if (node && node.elementId) rungMaps[i].set(node.elementId, nodeKeyString(node));
    }
    const path = rec.get('p');
    if (!path) continue;
    if (path.start && path.start.elementId) litNodes.add(path.start.elementId);
    for (const seg of path.segments || []) {
      if (seg.start) litNodes.add(seg.start.elementId);
      if (seg.end) litNodes.add(seg.end.elementId);
      if (seg.relationship) {
        litEdges.add(seg.relationship.elementId);
        litEdgeTriples.add(edgeTripleKey(seg.start, seg.relationship, seg.end));
      }
    }
  }

  const rungs = rungMaps.map((m) => ({
    count: m.size,
    names: [...m.values()].filter((v) => v !== null).sort(byteCompare),
    eids: [...m.keys()].sort(byteCompare),
  }));

  return { rungs, litNodes, litEdges, litEdgeTriples, paths: records.length };
}

/**
 * 先読みの応答 + schema → 候補の行。
 * schema を母集合にするので、0 件の候補も row として出る（ボタンは無効化して表示する）。
 */
export function parseLookahead(records, schemaRows, from, asNum = (v) => v) {
  const got = new Map();
  for (const rec of records) {
    const key = JSON.stringify([rec.get('rel'), rec.get('label')]);
    got.set(key, { nodes: asNum(rec.get('nodes')), edges: asNum(rec.get('edges')) });
  }
  return schemaRows
    .filter((row) => row.from === from)
    .map((row) => {
      const hit = got.get(JSON.stringify([row.rel, row.to]));
      return {
        rel: row.rel,
        label: row.to,
        nodes: hit ? hit.nodes : 0,
        edges: hit ? hit.edges : 0,
      };
    });
}

// ── ラダーの編集（すべて新しい配列を返す） ──────────────────────────────────

export function startWith(label) {
  return [{ label }];
}

export function append(ladder, cand) {
  return [...ladder, { rel: cand.rel, hops: [1, 1] }, { label: cand.label }];
}

/** i 番目の段のピンを設定・解除する。pin は {prop, value} か null。 */
export function setPin(ladder, i, pin) {
  if (!isRung(ladder[i])) return ladder;
  const next = ladder.map((s) => ({ ...s }));
  if (pin === null) delete next[i].pin;
  else next[i].pin = { prop: pin.prop, value: pin.value };
  return next;
}

/** 末尾の段のピンをトグルする。同じノードをもう一度クリックすると外れる。 */
export function togglePinOnLast(ladder, pin) {
  const i = ladder.length - 1;
  if (i < 0 || !isRung(ladder[i])) return ladder;
  const cur = ladder[i].pin;
  const same = cur && cur.prop === pin.prop && String(cur.value) === String(pin.value);
  return setPin(ladder, i, same ? null : pin);
}

export function cycleHops(ladder, i) {
  const step = ladder[i];
  if (!step || isRung(step)) return ladder;
  const cur = HOP_STEPS.findIndex(
    ([lo, hi]) => step.hops && step.hops[0] === lo && step.hops[1] === hi
  );
  const [lo, hi] = HOP_STEPS[(cur + 1 + HOP_STEPS.length) % HOP_STEPS.length];
  const next = ladder.map((s) => ({ ...s }));
  next[i].hops = [lo, hi];
  return next;
}

/** i 番目の行をクリックしてそこまで戻す。
 *  段（偶数）ならその段まで残し、辺（奇数）ならその辺の手前で切る。 */
export function truncate(ladder, i) {
  return ladder.slice(0, isRung(ladder[i]) ? i + 1 : i);
}

export function clear() {
  return [];
}

/** 構造の検証。段と辺が交互で、段で始まり段で終わること。 */
export function validate(ladder) {
  if (!Array.isArray(ladder)) return { ok: false, reason: 'not-an-array' };
  if (ladder.length === 0) return { ok: true, reason: null };
  if (ladder.length % 2 === 0) return { ok: false, reason: 'must-end-with-rung' };
  for (let i = 0; i < ladder.length; i++) {
    const wantRung = i % 2 === 0;
    if (isRung(ladder[i]) !== wantRung) return { ok: false, reason: `bad-step-${i}` };
    if (!wantRung && !ladder[i].rel) return { ok: false, reason: `edge-without-rel-${i}` };
  }
  if (rungCount(ladder) > MAX_RUNGS) return { ok: false, reason: 'too-many-rungs' };
  return { ok: true, reason: null };
}
