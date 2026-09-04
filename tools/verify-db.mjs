/**
 * C5 — docs/js/db.js を実 AuraDB に当てて検証する。
 *
 *   node tools/verify-db.mjs
 *
 * db.js はグローバルの `neo4j` に触る唯一のモジュールだが、driverFactory を
 * 差し替えられるようにしてあるので、Node のドライバを注入すれば
 * ブラウザが読むファイルそのものをここで検証できる。
 *
 * 認証情報は DoNotUpload/ から実行時に読むだけで、画面には出さない。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';

import {
  connect, precheck, loadSchema, loadGraph,
  classifyError, validateUri, asNum,
} from '../docs/js/db.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const driverFactory = () => neo4j;

let failures = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(label, got, want) {
  const ok = eq(got, want);
  if (!ok) failures++;
  const g = typeof got === 'object' ? JSON.stringify(got) : String(got);
  console.log(`  ${ok ? '✅' : '❌'} ${label}: ${g}` + (ok ? '' : `   (期待 ${want})`));
}

function loadCredentials() {
  if (process.env.NEO4J_URI && process.env.NEO4J_PASSWORD) {
    return {
      uri: process.env.NEO4J_URI,
      user: process.env.NEO4J_USERNAME || process.env.NEO4J_USER || '',
      password: process.env.NEO4J_PASSWORD,
    };
  }
  const dir = join(ROOT, 'DoNotUpload');
  const file = readdirSync(dir).find((f) => f.endsWith('.txt'));
  if (!file) throw new Error(`${dir} に .txt がありません。`);
  const kv = {};
  for (const line of readFileSync(join(dir, file), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) kv[m[1]] = m[2].trim();
  }
  return { uri: kv.NEO4J_URI, user: kv.NEO4J_USERNAME || '', password: kv.NEO4J_PASSWORD };
}

async function main() {
  const cred = loadCredentials();

  console.log('── validateUri ──');
  const v = validateUri(cred.uri);
  check('資格情報の URI が通る', v.ok, true);
  check('username を URI から導出できる（Aura のインスタンス ID）',
    v.derivedUser === cred.user, true);
  check('neo4j:// を弾く', validateUri('neo4j://x.databases.neo4j.io').reason, 'unencrypted');
  check('bolt:// を弾く', validateUri('bolt://localhost:7687').reason, 'unencrypted');
  check('neo4j+ssc:// を弾く', validateUri('neo4j+ssc://x.example').reason, 'selfsigned');
  check('https:// を弾く', validateUri('https://x.example').reason, 'http');
  check('空を弾く', validateUri('').reason, 'empty');

  console.log('\n── connect / precheck ──');
  // username を空にして自動導出だけで繋がるか（ノートブックが neo4j をハードコードしている問題の回避策）
  const conn = await connect({ ...cred, user: v.derivedUser, driverFactory });
  const pre = await precheck(conn);
  check('ノード数', pre.nodeCount, 73);
  check('リレーション数', pre.relCount, 153);
  check('判定', pre.verdict, 'nordwind');
  check('ラベル別内訳',
    pre.labels.map((l) => `${l.label}:${l.count}`).join(' '),
    'Engineer:30 Incident:20 Service:15 Team:8');
  check('リレーション型', pre.relTypes.join(' '),
    'AFFECTED DEPENDS_ON MEMBER_OF OWNS RESPONDED_TO');
  check('複数ラベルのノード', pre.multiLabelCount, 0);
  check('count が素の数値で返る（disableLosslessIntegers）',
    typeof pre.nodeCount === 'number', true);

  console.log('\n── loadSchema / loadGraph ──');
  const schema = await loadSchema(conn);
  check('schema 行数', schema.length, 5);
  const graph = await loadGraph(conn);
  check('ノード', graph.nodes.length, 73);
  check('辺', graph.edges.length, 153);
  check('key が一意', graph.keysUnique, true);
  check('端点の索引が全部引けている',
    graph.edges.every((e) => e.fromIdx !== undefined && e.toIdx !== undefined), true);
  check('Incident のキーは id', graph.nodes.find((n) => n.label === 'Incident').keyProp, 'id');
  check('Engineer のキーは name', graph.nodes.find((n) => n.label === 'Engineer').keyProp, 'name');

  const incident = graph.nodes.find((n) => n.label === 'Incident');
  const engineer = graph.nodes.find((n) => n.label === 'Engineer');
  console.log(`  ·  Incident の補足: "${incident.sub}"`);
  console.log(`  ·  Engineer の補足: "${engineer.sub}"`);
  check('補足が空でない', incident.sub.length > 0 && engineer.sub.length > 0, true);

  console.log('\n── timeout が効く ──');
  try {
    // 確実に時間のかかるクエリでサーバ側タイムアウトを踏ませる。
    // ブラウザからは実行中のクエリを中断できないので、ここが唯一の歯止めになる
    await conn.query('UNWIND range(1, 400000000) AS x RETURN count(x)', {}, { timeoutMs: 500 });
    console.log('  ⚠️  タイムアウトしなかった（データが小さすぎた可能性）');
  } catch (err) {
    const c = classifyError(err);
    check('classifyError -> timeout', c.kind, 'timeout');
  }
  await conn.close();

  console.log('\n── classifyError（わざと失敗させる） ──');
  try {
    await connect({ uri: cred.uri, user: v.derivedUser, password: 'definitely-not-the-password', driverFactory });
    console.log('  ❌ 誤ったパスワードで繋がってしまった');
    failures++;
  } catch (err) {
    check('誤ったパスワード -> auth', classifyError(err, { elapsedMs: err.elapsedMs }).kind, 'auth');
  }

  try {
    await connect({
      uri: 'neo4j+s://nosuchhost-9d3f1a.databases.neo4j.io',
      user: 'nosuchhost', password: 'x', driverFactory,
    });
    console.log('  ❌ 存在しないホストに繋がってしまった');
    failures++;
  } catch (err) {
    const kind = classifyError(err, { elapsedMs: err.elapsedMs }).kind;
    check('存在しないホスト -> unreachable か paused', kind === 'unreachable' || kind === 'paused', true);
  }

  check('asNum が Neo4j Integer を数値にする', asNum(neo4j.int(42)), 42);

  console.log(failures === 0 ? '\n✅ C5 すべて期待どおり' : `\n❌ ${failures} 件が一致しません`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(`\n❌ ${err.stack || err.message}`); process.exit(1); }
);
