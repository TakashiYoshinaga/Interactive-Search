/**
 * C1 — docs/js/ladder.js を実 AuraDB に当てて受け入れ値を検証する。
 *
 *   node tools/verify-ladder.mjs
 *
 * 認証情報は DoNotUpdate/ の Aura のファイルから実行時に読むだけで、
 * 画面にも出さないしどこにも書かない。--uri/--user/--password/--env でも渡せる。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';

import {
  toCypher, lookaheadCypher, lookaheadCypherPerCandidate,
  parseEvaluate, parseLookahead, rungCount, nodeKeyString, edgeTripleKey,
  byteCompare,
} from '../docs/js/ladder.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READ = (neo4j.routing && neo4j.routing.READ) || 'READ';

// ── 認証情報 ────────────────────────────────────────────────────────────────

function loadCredentials() {
  const fromEnv = {
    uri: process.env.NEO4J_URI,
    user: process.env.NEO4J_USERNAME || process.env.NEO4J_USER,
    password: process.env.NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE || 'neo4j',
  };
  if (fromEnv.uri && fromEnv.password) return fromEnv;

  const dir = join(ROOT, 'DoNotUpdate');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.txt'));
  } catch {
    throw new Error(`認証情報が見つかりません。${dir} に Aura の資格情報ファイルを置くか、環境変数 NEO4J_URI / NEO4J_PASSWORD を設定してください。`);
  }
  if (!files.length) throw new Error(`${dir} に .txt がありません。`);

  const text = readFileSync(join(dir, files[0]), 'utf8');
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) kv[m[1]] = m[2].trim();
  }
  if (!kv.NEO4J_URI || !kv.NEO4J_PASSWORD) {
    throw new Error(`${files[0]} に NEO4J_URI / NEO4J_PASSWORD が見つかりません。`);
  }
  // Aura は新しいインスタンスだと username がインスタンス ID。ファイルの値をそのまま使う
  return {
    uri: kv.NEO4J_URI,
    user: kv.NEO4J_USERNAME || 'neo4j',
    password: kv.NEO4J_PASSWORD,
    database: kv.NEO4J_DATABASE || 'neo4j',
  };
}

/** ログに出してよい形（ホスト名も伏せる）。 */
function safeLabel(cred) {
  const host = String(cred.uri).replace(/^[a-z+]+:\/\//, '').split('.')[0];
  const masked = host.length > 3 ? host.slice(0, 3) + '…' : '…';
  return `${masked}.databases.neo4j.io / db=${cred.database}`;
}

// ── アサーション ────────────────────────────────────────────────────────────

let failures = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(label, got, want) {
  const ok = eq(got, want);
  if (!ok) failures++;
  const g = typeof got === 'object' ? JSON.stringify(got) : String(got);
  const w = typeof want === 'object' ? JSON.stringify(want) : String(want);
  console.log(`  ${ok ? '✅' : '❌'} ${label}: ${g}${ok ? '' : `   (期待 ${w})`}`);
}

function note(label, value) {
  console.log(`  ·  ${label}: ${value}`);
}

// ── DB 問い合わせ ───────────────────────────────────────────────────────────

function makeRunner(driver, database) {
  return async function run(cypher, params = {}, timeoutMs = 8000) {
    const res = await driver.executeQuery(cypher, params, {
      database,
      routing: READ,
      transactionConfig: { timeout: timeoutMs },
    });
    return res.records;
  };
}

async function loadSchema(run) {
  const records = await run(
    'MATCH (a)-[r]->(b) ' +
    'RETURN DISTINCT labels(a)[0] AS src, type(r) AS rel, labels(b)[0] AS dst ORDER BY src, rel'
  );
  return records.map((r) => ({ from: r.get('src'), rel: r.get('rel'), to: r.get('dst') }));
}

async function evaluate(run, ladder) {
  const records = await run(toCypher(ladder));
  return parseEvaluate(records, rungCount(ladder));
}

async function lookaheadSingle(run, ladder, schema) {
  const cypher = lookaheadCypher(ladder);
  if (!cypher) return [];
  const records = await run(cypher);
  const from = ladder[ladder.length - 1].label;
  return parseLookahead(records, schema, from, (v) => (v && v.toNumber ? v.toNumber() : v));
}

/** 候補ごとに1本ずつ投げる素朴な版。等価性の検証にだけ使う。 */
async function lookaheadPerCandidate(run, ladder, schema) {
  const probes = lookaheadCypherPerCandidate(ladder, schema);
  const out = [];
  for (const probe of probes) {
    const records = await run(probe.cypher);
    const nRungs = rungCount(ladder) + 1;
    const nodes = new Set();
    const edges = new Set();
    for (const rec of records) {
      const tail = rec.get(`r${nRungs - 1}`);
      if (tail) nodes.add(tail.elementId);
      const segs = (rec.get('p') || {}).segments || [];
      if (segs.length) {
        const last = segs[segs.length - 1];
        edges.add(edgeTripleKey(last.start, last.relationship, last.end)); // 最後の1ホップ
      }
    }
    out.push({ rel: probe.rel, label: probe.label, nodes: nodes.size, edges: edges.size });
  }
  return out;
}

// ── ランダムなラダーの生成（等価性テスト用・決定論的） ──────────────────────

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

function randomLadders(schema, graphNodes, count, seed = 12345) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const labels = [...new Set(schema.flatMap((r) => [r.from, r.to]))].sort(byteCompare);
  const out = [];
  for (let i = 0; i < count; i++) {
    const ladder = [{ label: pick(labels) }];
    const steps = 1 + Math.floor(rnd() * 3);
    for (let s = 0; s < steps; s++) {
      const from = ladder[ladder.length - 1].label;
      const options = schema.filter((r) => r.from === from);
      if (!options.length) break;
      const row = pick(options);
      const hops = rnd() < 0.25 ? [1, 2] : [1, 1];
      ladder.push({ rel: row.rel, hops }, { label: row.to });
    }
    // たまに末尾の段をピン留めする
    if (rnd() < 0.35) {
      const label = ladder[ladder.length - 1].label;
      const pool = graphNodes.filter((n) => n.label === label && n.keyProp);
      if (pool.length) {
        const n = pick(pool);
        ladder[ladder.length - 1].pin = { prop: n.keyProp, value: n.key };
      }
    }
    out.push(ladder);
  }
  return out;
}

// ── 本体 ────────────────────────────────────────────────────────────────────

const HARD_QUESTION = [
  { label: 'Engineer' },
  { rel: 'RESPONDED_TO', hops: [1, 1] },
  { label: 'Incident' },
  { rel: 'AFFECTED', hops: [1, 1] },
  { label: 'Service' },
  { rel: 'DEPENDS_ON', hops: [1, 1] },
  { label: 'Service', pin: { prop: 'name', value: 'payment-gateway' } },
];

const GOLDEN_HARD_x13 =
  "MATCH p = (r0:Engineer)-[:RESPONDED_TO]->(r1:Incident)\n" +
  "          -[:AFFECTED]->(r2:Service)\n" +
  "          -[:DEPENDS_ON*1..3]->(r3:Service {name: 'payment-gateway'})\n" +
  'RETURN r0, r1, r2, r3, p';

async function main() {
  const cred = loadCredentials();
  console.log(`接続先: ${safeLabel(cred)}\n`);

  const driver = neo4j.driver(cred.uri, neo4j.auth.basic(cred.user, cred.password), {
    disableLosslessIntegers: true,
    maxConnectionPoolSize: 5,
  });

  try {
    await driver.verifyConnectivity();
    const run = makeRunner(driver, cred.database);

    console.log('── executeQuery の作法 ──');
    try {
      const r = await run('RETURN 1 AS one');
      check('transactionConfig:{timeout} + routing:READ が通る', r[0].get('one'), 1);
    } catch (e) {
      failures++;
      console.log(`  ❌ transactionConfig:{timeout} が拒否された: ${e.message}`);
      console.log('     → db.js は session.executeRead(txFn, {timeout}) に落とすこと');
    }

    console.log('\n── 単一段（長さ0のパス）: ユーザーが最初に作るクエリ ──');
    const first = await evaluate(run, [{ label: 'Engineer' }]);
    check('rungs[0]', first.rungs[0].count, 30);
    check('paths', first.paths, 30);
    check('litNodes', first.litNodes.size, 30);
    check('litEdges', first.litEdges.size, 0);

    console.log('\n── schema ──');
    const schema = await loadSchema(run);
    check('行数', schema.length, 5);
    for (const r of schema) note('', `(:${r.from}) -[:${r.rel}]-> (:${r.to})`);

    console.log('\n── fullGraph ──');
    const nodeRecords = await run('MATCH (n) RETURN n');
    const edgeRecords = await run('MATCH (a)-[r]->(b) RETURN a, r, b');
    const graphNodes = nodeRecords.map((rec) => {
      const n = rec.get('n');
      const props = n.properties || {};
      return {
        eid: n.elementId,
        label: n.labels[0],
        key: nodeKeyString(n),
        keyProp: props.name !== undefined ? 'name' : props.id !== undefined ? 'id' : null,
      };
    });
    check('ノード数', graphNodes.length, 73);
    check('リレーション数', edgeRecords.length, 153);
    check('key が一意（identity と key が一致する DB か）',
      new Set(graphNodes.map((n) => n.key)).size, 73);

    console.log('\n── ハードクエスチョン (DEPENDS_ON x1) ──');
    const r1 = await evaluate(run, HARD_QUESTION);
    check('rungs', r1.rungs.map((r) => r.count), [10, 6, 1, 1]);
    check('litNodes', r1.litNodes.size, 18);
    check('litEdges (elementId)', r1.litEdges.size, 24);
    check('litEdges (from|TYPE|to)', r1.litEdgeTriples.size, 24);
    check('paths', r1.paths, 17);
    const keyByEid = new Map(graphNodes.map((n) => [n.eid, n.key]));
    check('結果名と elementId の対応', r1.rungs.every((rung) =>
      rung.names.every((name, i) => keyByEid.get(rung.eids[i]) === name)), true);
    note('答えのエンジニア', r1.rungs[0].names.join(', '));

    console.log('\n── 可変長 (DEPENDS_ON x1..3) ──');
    const wide = HARD_QUESTION.map((s) => ({ ...s }));
    wide[5] = { rel: 'DEPENDS_ON', hops: [1, 3] };
    const r2 = await evaluate(run, wide);
    check('rungs[0] (エンジニア数)', r2.rungs[0].count, 18);
    check('litNodes', r2.litNodes.size, 36);
    check('litEdges', r2.litEdges.size, 54);
    check('toCypher の出力が golden と一致', toCypher(wide), GOLDEN_HARD_x13);

    console.log('\n── 先読み ((:Engineer) の直後) ──');
    const cands = await lookaheadSingle(run, [{ label: 'Engineer' }], schema);
    check('候補数', cands.length, 2);
    const byRel = Object.fromEntries(cands.map((c) => [c.rel, c]));
    check('RESPONDED_TO', [byRel.RESPONDED_TO?.nodes, byRel.RESPONDED_TO?.edges], [20, 52]);
    check('MEMBER_OF', [byRel.MEMBER_OF?.nodes, byRel.MEMBER_OF?.edges], [8, 30]);

    console.log('\n── 0 件の候補が行として残るか（先読みの肝） ──');
    const deadCands = await lookaheadSingle(run, [
      { label: 'Service', pin: { prop: 'name', value: 'auth-service' } },
    ], schema);
    check('0 件でも候補行を残す', deadCands.length, 1);
    check('auth-service の次は行き止まり',
      [deadCands[0]?.rel, deadCands[0]?.label, deadCands[0]?.nodes, deadCands[0]?.edges],
      ['DEPENDS_ON', 'Service', 0, 0]);

    console.log('\n── 単一クエリ版の先読み == N 本版 ──');
    const ladders = randomLadders(schema, graphNodes, 20);
    let mismatches = 0;
    for (const ladder of ladders) {
      const [a, b] = await Promise.all([
        lookaheadSingle(run, ladder, schema),
        lookaheadPerCandidate(run, ladder, schema),
      ]);
      const norm = (rows) => rows
        .map((r) => `${r.rel}>${r.label}:${r.nodes}/${r.edges}`)
        .sort(byteCompare).join(' ');
      // N 本版は 0 件の候補を返さないので、単一版から 0 行を落として比べる
      const aNorm = norm(a.filter((r) => r.nodes > 0));
      const bNorm = norm(b.filter((r) => r.nodes > 0));
      if (aNorm !== bNorm) {
        mismatches++;
        console.log(`  ❌ 不一致\n     ladder: ${toCypher(ladder).replace(/\n\s*/g, ' ')}`);
        console.log(`     単一: ${aNorm}\n     N本: ${bNorm}`);
      }
    }
    check(`ランダムなラダー ${ladders.length} 本`, mismatches, 0);
  } finally {
    await driver.close();
  }

  console.log(failures === 0 ? '\n✅ C1 すべて期待どおり' : `\n❌ ${failures} 件が一致しません`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  }
);
