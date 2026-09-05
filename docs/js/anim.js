/**
 * 「何が光っているか」の唯一の定義と、そのトゥイーン。
 *
 * ここが純関数で1か所にまとまっていることが重要で、2D と 3D のレンダラは
 * どちらもこのバッファを読むだけの消費者になる。だから両者が食い違いようがなく、
 * モード切替の最中のフェードもそのまま継続する（cur を作り直さないので）。
 *
 * ノードは独立した5つの 0..1 を持つ:
 *   lit   0 = 減衰している / 1 = 生きている
 *   hot   1 = ラダーに一致した
 *   hover ポインタが乗っている
 *   neighbor ホバー中のノードに直接つながっている（検索中は一致した入出辺のみ）
 *   pin   ピン留めされている
 * 辺は lit / hot と、ホバー中のノードにつながる hover の3つ。
 * 接続の強調は検索結果の lit / hot を変えず、別のチャンネルで重ねる。
 *
 * hover と pin のアクセントは減衰中でも生き残らせる。薄くなったノードを
 * 指しても反応が返らないと、ピン留めできることに気付けない。
 */

// dt ベースの指数ダンピング。60Hz でも 120Hz でも同じ速さで動く
const TAU = 0.30;            // 0.3 秒で 99.9% 到達
const SETTLED = 0.0015;      // これ以下の差になったら止める

const NODE_CHANNELS = ['lit', 'hot', 'hover', 'neighbor', 'pin'];
const EDGE_CHANNELS = ['lit', 'hot', 'hover'];

/**
 * 状態 → 各チャンネルの目標値（0/1）。純関数。
 *
 * @param graph      {nodes: [{eid}], edges: [{eid, fromIdx, toIdx}]}
 * @param result     {litNodes: Set<eid>, litEdges: Set<eid>, paths} か null
 * @param hoverEid   ホバー中のノードの elementId か null
 * @param pinnedEids ピン留めされているノードの elementId の Set
 */
export function computeVisual(graph, result, hoverEid, pinnedEids) {
  const n = graph.nodes.length;
  const m = graph.edges.length;
  const out = {
    nodeLit: new Uint8Array(n), nodeHot: new Uint8Array(n),
    nodeHover: new Uint8Array(n), nodeNeighbor: new Uint8Array(n), nodePin: new Uint8Array(n),
    edgeLit: new Uint8Array(m), edgeHot: new Uint8Array(m), edgeHover: new Uint8Array(m),
  };

  const hasLadder = !!(result && result.cypher);
  const litNodes = result && result.litNodes;
  const litEdges = result && result.litEdges;
  const hoverIdx = hoverEid == null ? -1 : graph.nodes.findIndex((node) => node.eid === hoverEid);

  for (let i = 0; i < n; i++) {
    const eid = graph.nodes[i].eid;
    if (!hasLadder) {
      // ラダーを組む前。全部そのまま見えている状態
      out.nodeLit[i] = 1;
    } else if (litNodes && litNodes.has(eid)) {
      out.nodeLit[i] = 1;
      out.nodeHot[i] = 1;
    }
    // 結果 0 件なら全部減衰する。「全部光る」にしないこと（絞り込みの逆に見える）
    if (i === hoverIdx) out.nodeHover[i] = 1;
    if (pinnedEids && pinnedEids.has(eid)) out.nodePin[i] = 1;
  }

  for (let e = 0; e < m; e++) {
    const { eid, fromIdx, toIdx } = graph.edges[e];
    if (!hasLadder) {
      out.edgeLit[e] = 1;
    } else if (litEdges && litEdges.has(eid)) {
      out.edgeLit[e] = 1;
      out.edgeHot[e] = 1;
    }
    const canTrace = !hasLadder || (litEdges && litEdges.has(eid));
    if (canTrace && hoverIdx >= 0 && (fromIdx === hoverIdx || toIdx === hoverIdx)) {
      out.edgeHover[e] = 1;
      if (fromIdx !== hoverIdx && fromIdx >= 0 && fromIdx < n) out.nodeNeighbor[fromIdx] = 1;
      if (toIdx !== hoverIdx && toIdx >= 0 && toIdx < n) out.nodeNeighbor[toIdx] = 1;
    }
  }

  return out;
}

/** トゥイーンのバッファ。グラフを読み込んだときに1回だけ確保する。 */
export function createAnim(nNodes, nEdges) {
  const make = () => ({
    nodeLit: new Float32Array(nNodes), nodeHot: new Float32Array(nNodes),
    nodeHover: new Float32Array(nNodes), nodeNeighbor: new Float32Array(nNodes), nodePin: new Float32Array(nNodes),
    edgeLit: new Float32Array(nEdges), edgeHot: new Float32Array(nEdges), edgeHover: new Float32Array(nEdges),
  });
  const cur = make();
  const target = make();
  const keys = [
    ...NODE_CHANNELS.map((c) => 'node' + c[0].toUpperCase() + c.slice(1)),
    ...EDGE_CHANNELS.map((c) => 'edge' + c[0].toUpperCase() + c.slice(1)),
  ];

  // 起動直後は全部見えている状態から始める（フェードインさせない）
  cur.nodeLit.fill(1);
  target.nodeLit.fill(1);
  cur.edgeLit.fill(1);
  target.edgeLit.fill(1);

  return {
    cur,
    target,

    setTargets(visual) {
      for (const key of keys) {
        const src = visual[key];
        const dst = target[key];
        if (!src || !dst) continue;
        for (let i = 0; i < dst.length; i++) dst[i] = src[i];
      }
    },

    /** @returns true なら落ち着いたので rAF を止めてよい */
    step(dt) {
      const k = 1 - Math.pow(0.001, Math.min(dt, 0.1) / TAU);
      let settled = true;
      for (const key of keys) {
        const c = cur[key];
        const t = target[key];
        for (let i = 0; i < c.length; i++) {
          const d = t[i] - c[i];
          if (d > SETTLED || d < -SETTLED) {
            c[i] += d * k;
            settled = false;
          } else {
            c[i] = t[i];
          }
        }
      }
      return settled;
    },

    /** アニメーションを飛ばして目標値にする。 */
    snap() {
      for (const key of keys) cur[key].set(target[key]);
    },
  };
}
