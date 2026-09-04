/**
 * Neo4j への接続。グローバル `neo4j`（vendor/neo4j-web.min.js が作る）に触る唯一のモジュール。
 *
 * 認証情報はメモリにしか置かない。localStorage / sessionStorage / cookie /
 * URL パラメータのどれにも書かないし、ソースにも決して埋め込まない。
 *
 * driverFactory を差し替えられるようにしてあるので、Node からドライバを注入して
 * このファイルそのものを検証できる（tools/verify-db.mjs）。
 */

import { nodeKeyString, byteCompare } from './ladder.js';

const DEFAULT_TIMEOUT_MS = 8000;
const POOL_SIZE = 5;

// このツールはグラフ全体を描くので、ワークショップ規模を超えたら断る。
// MATCH (n) RETURN n を投げる前に必ず count で確かめること（順序を逆にするとタブが落ちる）
export const MAX_NODES = 2000;
export const MAX_RELS = 5000;

// 接続に時間がかかってから落ちたら、塞がれているのではなく休止中の可能性が高い
const PAUSED_HINT_MS = 12000;

const OK_SCHEMES = ['neo4j+s://', 'bolt+s://'];

// 説明文に使うプロパティは決め打ちしない。キー以外の短い文字列を名前順に2つ拾う
const SUB_MAX_PROPS = 2;
const SUB_MAX_LEN = 60;

/** Neo4j の Integer を素の数値に落とす。disableLosslessIntegers を付けていても通す。 */
export function asNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * URI の検証と username の自動導出。
 * ブラウザから使えるのは TLS 付きのスキームだけ。
 */
export function validateUri(raw) {
  const uri = String(raw || '').trim();
  if (!uri) return { ok: false, reason: 'empty' };
  if (OK_SCHEMES.some((s) => uri.startsWith(s))) {
    const host = uri.slice(uri.indexOf('://') + 3).split('/')[0];
    // 現行 Aura では username = インスタンス ID = ホスト名の先頭セグメント
    const derivedUser = host.split('.')[0] || 'neo4j';
    return { ok: true, reason: null, derivedUser, host };
  }
  if (/^neo4j:\/\/|^bolt:\/\//.test(uri)) return { ok: false, reason: 'unencrypted' };
  if (/^neo4j\+ssc:\/\/|^bolt\+ssc:\/\//.test(uri)) return { ok: false, reason: 'selfsigned' };
  if (/^https?:\/\//.test(uri)) return { ok: false, reason: 'http' };
  return { ok: false, reason: 'scheme' };
}

/** 例外を画面の文言に結びつけられる形にする。 */
export function classifyError(err, { elapsedMs = 0 } = {}) {
  const code = (err && err.code) || '';
  const name = (err && err.name) || '';
  const message = String((err && err.message) || err || '');
  const detail = message.slice(0, 300);
  const of = (kind) => ({ kind, code: code || name, detail });

  if (code === 'Neo.ClientError.Security.Unauthorized') return of('auth');
  if (code === 'Neo.ClientError.Security.AuthenticationRateLimit') return of('ratelimit');
  if (code === 'Neo.ClientError.Security.Forbidden') return of('forbidden');
  if (code === 'Neo.ClientError.Statement.SyntaxError') return of('syntax');
  if (code === 'Neo.ClientError.Database.DatabaseNotFound') return of('dbnotfound');
  // 実測では TransactionTimedOutClientConfiguration という接尾辞つきで返る。前方一致で拾う
  if (code.startsWith('Neo.ClientError.Transaction.TransactionTimedOut')
      || code === 'Neo.ClientError.Transaction.LockClientStopped'
      || /Terminated/.test(code)
      || /timed? ?out/i.test(message)) return of('timeout');
  if (name === 'Neo4jError' && /routing table/i.test(message)) return of('unreachable');
  if (name === 'ServiceUnavailable' || code === 'ServiceUnavailable'
      || name === 'SessionExpired' || /WebSocket|connection|ECONN|Failed to connect/i.test(message)) {
    return of(elapsedMs >= PAUSED_HINT_MS ? 'paused' : 'unreachable');
  }
  return of('unknown');
}

// ── 接続 ────────────────────────────────────────────────────────────────────

/**
 * @returns Conn { uri, user, query(cypher, params, opts), close(), isLive }
 */
export async function connect({ uri, user, password, driverFactory }) {
  const factory = driverFactory || (() => globalThis.neo4j);
  const lib = factory();
  if (!lib || typeof lib.driver !== 'function') {
    throw new Error('Neo4j driver is not loaded');
  }

  const READ = (lib.routing && lib.routing.READ) || 'READ';
  const driver = lib.driver(uri, lib.auth.basic(user, password), {
    // これを付けないと count() が {low, high} で返ってくる
    disableLosslessIntegers: true,
    maxConnectionPoolSize: POOL_SIZE,
  });

  const started = Date.now();
  try {
    await driver.verifyConnectivity();
  } catch (err) {
    await driver.close().catch(() => {});
    err.elapsedMs = Date.now() - started;
    throw err;
  }

  let live = true;

  return {
    uri,
    user,
    get isLive() { return live; },

    /**
     * database は渡さない。現行 Aura ではデータベース名がインスタンス ID なので
     * 'neo4j' を渡すと DatabaseNotFound になる。省略すればドライバがホーム DB を解決する。
     * routing を明示しないと executeQuery は既定で WRITE に流れる。
     * ブラウザからは実行中のクエリを中断できないので、サーバ側 timeout が唯一の歯止め。
     */
    async query(cypher, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      const t0 = (globalThis.performance || Date).now();
      const res = await driver.executeQuery(cypher, params, {
        routing: READ,
        transactionConfig: { timeout: timeoutMs },
      });
      const ms = Math.round((globalThis.performance || Date).now() - t0);
      return { records: res.records, keys: res.keys, summary: res.summary, ms };
    },

    async close() {
      live = false;
      await driver.close().catch(() => {});
    },
  };
}

// ── 起動時の確認 ────────────────────────────────────────────────────────────

const NORDWIND_LABELS = ['Engineer', 'Incident', 'Service', 'Team'];

/**
 * 接続直後に「何が入っているか」を確かめる。
 * 規模の判定を先にやること。MATCH (n) RETURN n を先に投げるとタブが落ちる。
 */
export async function precheck(conn) {
  const counts = await conn.query(
    'MATCH (n) WITH count(n) AS nodeCount ' +
    'OPTIONAL MATCH ()-[r]->() RETURN nodeCount, count(r) AS relCount'
  );
  const row = counts.records[0];
  const nodeCount = asNum(row && row.get('nodeCount'));
  const relCount = asNum(row && row.get('relCount'));

  if (nodeCount === 0) {
    return { nodeCount, relCount, labels: [], relTypes: [], multiLabelCount: 0, verdict: 'empty' };
  }
  if (nodeCount > MAX_NODES || relCount > MAX_RELS) {
    return { nodeCount, relCount, labels: [], relTypes: [], multiLabelCount: 0, verdict: 'toolarge' };
  }

  const census = await conn.query(
    'MATCH (n) RETURN labels(n)[0] AS label, count(*) AS c, ' +
    'sum(CASE WHEN size(labels(n)) > 1 THEN 1 ELSE 0 END) AS multi ORDER BY label'
  );
  const labels = census.records.map((r) => ({
    label: r.get('label'),
    count: asNum(r.get('c')),
  }));
  const multiLabelCount = census.records.reduce((a, r) => a + asNum(r.get('multi')), 0);

  const types = await conn.query('MATCH ()-[r]->() RETURN DISTINCT type(r) AS t ORDER BY t');
  const relTypes = types.records.map((r) => r.get('t'));

  const names = labels.map((l) => l.label).sort(byteCompare);
  const looksLikeWorkshop =
    nodeCount === 73 && relCount === 153 &&
    names.length === NORDWIND_LABELS.length &&
    names.every((v, i) => v === NORDWIND_LABELS[i]);

  return {
    nodeCount, relCount, labels, relTypes, multiLabelCount,
    verdict: looksLikeWorkshop ? 'nordwind' : 'other',
  };
}

/** どのラベルからどのリレーションでどのラベルへ行けるか。ハードコードせず DB から導く。 */
export async function loadSchema(conn) {
  const res = await conn.query(
    'MATCH (a)-[r]->(b) ' +
    'RETURN DISTINCT labels(a)[0] AS src, type(r) AS rel, labels(b)[0] AS dst ORDER BY src, rel'
  );
  return res.records.map((r) => ({ from: r.get('src'), rel: r.get('rel'), to: r.get('dst') }));
}

/** ホバー時に出す補足。ラベル名で分岐せず、キー以外の短い文字列を名前順に拾う。 */
function describe(props, keyProp) {
  const picks = [];
  for (const name of Object.keys(props).sort(byteCompare)) {
    if (name === keyProp || picks.length >= SUB_MAX_PROPS) continue;
    const v = props[name];
    if (typeof v !== 'string' || !v) continue;
    picks.push(v.length > SUB_MAX_LEN ? v.slice(0, SUB_MAX_LEN - 1) + '…' : v);
  }
  return picks.join(' · ');
}

/**
 * 全ノード・全辺。起動時に1回だけ取り、以降は書き換えない。
 * identity は elementId、表示キーは name ?? id。両者を分けておかないと
 * 同名ノードのある DB でカウンタが黙って食い違う。
 */
export async function loadGraph(conn) {
  const [nodeRes, edgeRes] = await Promise.all([
    conn.query('MATCH (n) RETURN n', {}, { timeoutMs: 20000 }),
    conn.query('MATCH (a)-[r]->(b) RETURN a, r, b', {}, { timeoutMs: 20000 }),
  ]);

  const nodes = nodeRes.records.map((rec) => {
    const n = rec.get('n');
    const props = n.properties || {};
    const keyProp = props.name !== undefined && props.name !== null ? 'name'
      : props.id !== undefined && props.id !== null ? 'id'
      : null;
    const key = nodeKeyString(n) || n.elementId;
    return {
      eid: n.elementId,
      key,
      keyProp,
      keyValue: keyProp ? props[keyProp] : null,
      label: (n.labels && n.labels[0]) || '',
      name: key,
      sub: describe(props, keyProp),
    };
  });

  // 並びを固定する。レイアウトの再現性と、画面の一貫性のため
  nodes.sort((a, b) => byteCompare(a.label, b.label) || byteCompare(a.key, b.key));
  const idxByEid = new Map(nodes.map((n, i) => [n.eid, i]));
  const idxByKey = new Map(nodes.map((n, i) => [n.key, i]));

  const edges = edgeRes.records.map((rec) => {
    const a = rec.get('a'), r = rec.get('r'), b = rec.get('b');
    return {
      eid: r.elementId,
      type: r.type,
      from: a.elementId,
      to: b.elementId,
      fromIdx: idxByEid.get(a.elementId),
      toIdx: idxByEid.get(b.elementId),
    };
  });
  edges.sort((p, q) =>
    byteCompare(nodes[p.fromIdx] ? nodes[p.fromIdx].key : '', nodes[q.fromIdx] ? nodes[q.fromIdx].key : '')
    || byteCompare(p.type, q.type)
    || byteCompare(nodes[p.toIdx] ? nodes[p.toIdx].key : '', nodes[q.toIdx] ? nodes[q.toIdx].key : ''));

  const labelTotals = {};
  for (const n of nodes) labelTotals[n.label] = (labelTotals[n.label] || 0) + 1;
  const labels = Object.keys(labelTotals).sort(byteCompare);

  // key が一意でないと layout.json の索引に使えないし、ピン留めも 1 個に絞れない
  const keysUnique = idxByKey.size === nodes.length;

  return { nodes, edges, labels, labelTotals, idxByEid, idxByKey, keysUnique };
}
