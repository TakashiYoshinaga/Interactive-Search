/**
 * C2 — docs/js/layout.js を Node で回して docs/data/layout.json を焼く。
 *
 *   node tools/bake-layout.mjs           焼く（実 DB からグラフを読む）
 *   node tools/bake-layout.mjs --check   焼かずに決定性だけ確かめる
 *
 * 焼いた座標を同梱しておくと、教室で講師の投影画面と受講者の画面が
 * まったく同じ絵になる。実行時に計算しても決定論的なので同じ絵にはなるが、
 * 起動が少し速くなるのと、気に入らない配置を手で直せるのが利点。
 *
 * 認証情報は DoNotUpdate/ から実行時に読むだけで、画面には出さない。
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';

import { computeLayout, graphSignature, byteCompare } from '../docs/js/layout.js';
import { nodeKeyString } from '../docs/js/ladder.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'data', 'layout.json');
const READ = (neo4j.routing && neo4j.routing.READ) || 'READ';

function loadCredentials() {
  if (process.env.NEO4J_URI && process.env.NEO4J_PASSWORD) {
    return {
      uri: process.env.NEO4J_URI,
      user: process.env.NEO4J_USERNAME || process.env.NEO4J_USER || 'neo4j',
      password: process.env.NEO4J_PASSWORD,
    };
  }
  const dir = join(ROOT, 'DoNotUpdate');
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt'));
  if (!files.length) throw new Error(`${dir} に .txt がありません。`);
  const kv = {};
  for (const line of readFileSync(join(dir, files[0]), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) kv[m[1]] = m[2].trim();
  }
  return { uri: kv.NEO4J_URI, user: kv.NEO4J_USERNAME || 'neo4j', password: kv.NEO4J_PASSWORD };
}

async function loadGraph() {
  const cred = loadCredentials();
  const driver = neo4j.driver(cred.uri, neo4j.auth.basic(cred.user, cred.password), {
    disableLosslessIntegers: true,
  });
  try {
    // database は渡さない。現行 Aura では 'neo4j' が存在せず DatabaseNotFound になる
    const q = (cypher) =>
      driver.executeQuery(cypher, {}, { routing: READ, transactionConfig: { timeout: 15000 } });

    const nodeRes = await q('MATCH (n) RETURN n');
    const edgeRes = await q('MATCH (a)-[r]->(b) RETURN a, r, b');

    const byEid = new Map();
    const nodes = nodeRes.records.map((rec) => {
      const n = rec.get('n');
      const node = { id: nodeKeyString(n) || n.elementId, label: n.labels[0] || '' };
      byEid.set(n.elementId, node.id);
      return node;
    });
    const edges = edgeRes.records.map((rec) => ({
      from: byEid.get(rec.get('a').elementId),
      to: byEid.get(rec.get('b').elementId),
    }));
    return { nodes, edges };
  } finally {
    await driver.close();
  }
}

/** 座標配列の FNV-1a。決定性の指紋。 */
function hashPositions(pos) {
  const s = Object.keys(pos).sort(byteCompare).map((k) => `${k}:${pos[k].join(',')}`).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function serialize(payload) {
  const keys = Object.keys(payload.positions).sort(byteCompare);
  const lines = keys.map((k) => `  ${JSON.stringify(k)}: [${payload.positions[k].join(', ')}]`);
  return `{\n  "signature": ${JSON.stringify(payload.signature)},\n` +
    `  "hash": ${JSON.stringify(payload.hash)},\n` +
    `  "positions": {\n${lines.join(',\n')}\n  }\n}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const { nodes, edges } = await loadGraph();
  console.log(`グラフ: ノード ${nodes.length} / 辺 ${edges.length}`);

  const t0 = Date.now();
  const a = computeLayout(nodes, edges);
  const ms = Date.now() - t0;
  const b = computeLayout(nodes, edges);

  const ha = hashPositions(a);
  const hb = hashPositions(b);
  console.log(`  計算 ${ms} ms`);
  console.log(`  ${ha === hb ? '✅' : '❌'} 2回計算して一致: ${ha}`);

  // 入力順を変えても同じになるか（内部でソートしているので変わってはいけない）
  const shuffled = computeLayout([...nodes].reverse(), [...edges].reverse());
  const hs = hashPositions(shuffled);
  console.log(`  ${hs === ha ? '✅' : '❌'} 入力順を逆にしても一致: ${hs}`);

  const xs = Object.values(a).map((p) => p[0]);
  const ys = Object.values(a).map((p) => p[1]);
  const zs = Object.values(a).map((p) => p[2]);
  const range = (v) => `[${Math.min(...v).toFixed(2)}, ${Math.max(...v).toFixed(2)}]`;
  console.log(`  範囲: x ${range(xs)}  y ${range(ys)}  z ${range(zs)}`);

  const ok = ha === hb && hs === ha;
  if (check) {
    console.log(ok ? '\n✅ C2 決定的' : '\n❌ 決定的でない');
    return ok ? 0 : 1;
  }
  if (!ok) {
    console.log('\n❌ 決定的でないので焼かない');
    return 1;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, serialize({ signature: graphSignature(nodes, edges), hash: ha, positions: a }), 'utf8');
  console.log(`\n✅ 焼きました: docs/data/layout.json (${Object.keys(a).length} ノード)`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(`\n❌ ${err.message}`); process.exit(1); }
);
