/** node tools/verify-visual.mjs — 接続不要。ホバーと検索結果の独立性を検証する。 */
import assert from 'node:assert/strict';
import { computeVisual, createAnim } from '../docs/js/anim.js';

const graph = Object.freeze({
  nodes: Object.freeze(['a', 'b', 'c', 'd', 'isolated'].map((eid) => Object.freeze({ eid }))),
  edges: Object.freeze([
    { eid: 'ab', fromIdx: 0, toIdx: 1 },
    { eid: 'ca', fromIdx: 2, toIdx: 0 },
    { eid: 'bd', fromIdx: 1, toIdx: 3 },
    { eid: 'aa', fromIdx: 0, toIdx: 0 },
    { eid: 'ab2', fromIdx: 0, toIdx: 1 },
  ].map(Object.freeze)),
});
const pins = new Set(['c']);
const query = {
  cypher: 'MATCH p = (a)-[r]->(b) RETURN p',
  litNodes: new Set(['b', 'd']), litEdges: new Set(['bd']),
};
const values = (buffer) => [...buffer];
const active = (buffer, items) => items.filter((_, i) => buffer[i] === 1).map((item) => item.eid);

const idle = computeVisual(graph, null, null, pins);
assert.ok(values(idle.nodeLit).every((v) => v === 1));
assert.ok(values(idle.edgeLit).every((v) => v === 1));
assert.ok(values(idle.nodeNeighbor).every((v) => v === 0));

const hover = computeVisual(graph, null, 'a', pins);
assert.deepEqual(active(hover.nodeHover, graph.nodes), ['a']);
assert.deepEqual(active(hover.nodeNeighbor, graph.nodes), ['b', 'c']);
assert.deepEqual(active(hover.edgeHover, graph.edges), ['ab', 'ca', 'aa', 'ab2']);
console.log('PASS: incoming/outgoing neighbors, parallel edges and self-loop; no second-hop expansion');

const inQuery = computeVisual(graph, query, 'b', pins);
assert.deepEqual(active(inQuery.nodeNeighbor, graph.nodes), ['d']);
assert.deepEqual(active(inQuery.edgeHover, graph.edges), ['bd']);
assert.deepEqual(active(inQuery.nodeHot, graph.nodes), ['b', 'd']);
assert.deepEqual(active(inQuery.edgeHot, graph.edges), ['bd']);
const outsideQuery = computeVisual(graph, query, 'a', pins);
assert.deepEqual(active(outsideQuery.nodeHover, graph.nodes), ['a']);
assert.deepEqual(active(outsideQuery.nodeNeighbor, graph.nodes), []);
assert.deepEqual(active(outsideQuery.edgeHover, graph.edges), []);
const emptyQuery = computeVisual(graph, { cypher: 'RETURN null', litNodes: new Set(), litEdges: new Set() }, 'a', pins);
assert.deepEqual(active(emptyQuery.nodeNeighbor, graph.nodes), []);
assert.deepEqual(active(emptyQuery.edgeHover, graph.edges), []);
console.log('PASS: ladder hover follows only matching edges; excluded nodes and empty results do not reveal unrelated structure');

for (const result of [null, query, { cypher: 'RETURN null', litNodes: new Set(), litEdges: new Set() }]) {
  const base = computeVisual(graph, result, null, pins);
  for (const eid of ['a', 'b', 'isolated', 'missing', null]) {
    const visual = computeVisual(graph, result, eid, pins);
    for (const channel of ['nodeLit', 'nodeHot', 'nodePin', 'edgeLit', 'edgeHot']) {
      assert.deepEqual(values(visual[channel]), values(base[channel]), `${channel} changed for hover ${eid}`);
    }
  }
}
for (const eid of ['isolated', 'missing', null]) {
  const visual = computeVisual(graph, query, eid, pins);
  assert.ok(values(visual.nodeNeighbor).every((v) => v === 0));
  assert.ok(values(visual.edgeHover).every((v) => v === 0));
}
console.log('PASS: query results (including zero results) and pins stay unchanged; isolated/missing/cleared hover');

const anim = createAnim(graph.nodes.length, graph.edges.length);
anim.setTargets(hover);
anim.step(1 / 60);
assert.ok(anim.cur.nodeNeighbor[1] > 0 && anim.cur.nodeNeighbor[1] < 1);
assert.ok(anim.cur.edgeHover[0] > 0 && anim.cur.edgeHover[0] < 1);
anim.setTargets(computeVisual(graph, query, 'b', pins));
anim.snap();
assert.deepEqual(active(anim.cur.nodeNeighbor, graph.nodes), ['d']);
const cleared = computeVisual(graph, query, null, pins);
anim.setTargets(cleared);
for (let i = 0; i < 120; i++) anim.step(1 / 60);
assert.equal(anim.step(1 / 60), true);
for (const channel of Object.keys(cleared)) {
  assert.deepEqual(values(anim.cur[channel]), values(cleared[channel]), `${channel} did not settle`);
}
console.log('PASS: hover transitions animate, switch neighbors and restore the previous result');
