/**
 * 3D の描画。view2d.js と同じインタフェースを実装するので app.js は無改造で切り替わる。
 *
 * three は 3D に切り替えたときだけ動的 import する（2D しか使わない人に読ませない）。
 *
 * 色は 2D とまったく同じマットなパレットを使う。bloom も星空も加算合成も使わない。
 * つや消しの MeshStandardMaterial に弱い emissive、照明は半球光 + 平行光1灯、影なし。
 *
 * 減衰は「透明度」ではなく「背景色へ混ぜる」で表現している。背景が不透明な単色なので
 * 見た目は同じで、半透明の描画順の問題（3D では重なりが破綻しやすい）が丸ごと消える。
 *
 * 位置は 2D と同じ x, y をビットレベルで共有し、z を足すだけ。だから 2D↔3D の
 * 切り替えはレイアウトのやり直しではなくカメラの移動として読める。
 */

import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from '../vendor/CSS2DRenderer.js';
import { parseHex, mix, toHex } from './theme.js';

const FOV = 45;
const FIT_MARGIN = 1.08;
// カメラ空間の右・上・手前。角度の調整はこの定数だけで行う。
const LIGHT_OFFSET = new THREE.Vector3(0.5, 0.7, 1.2);
// theme.js の半径（2D ではピクセル。最大 11 / 最小 4.5）をワールド単位に落とす係数。
// 2D は fit 時に「最大のノードが約 11px」＝レイアウトの広がりの 2〜3% になるので、
// 3D もその見え方に揃える。ここを大きくするとノードが互いに埋まり、辺も構造も見えなくなる。
// 形ごとのジオメトリ自体が半径 1.2〜1.7 を持っているぶんも見込んでいる。
const NODE_SCALE = 0.006;
// 面の色を白へ少し寄せる。MeshStandardMaterial は照明を掛けた結果を出すので、
// パレットの色をそのまま入れると 2D より暗く沈んで見える。その分を持ち上げる
const NODE_LIFT = 0.16;
const CAM_TWEEN_SEC = 0.5;
const FOCUS_DISTANCE = 1.55;
// カメラを注視点より上に置く量（距離に対する比）。正で見下ろし、負で見上げになる
const TILT = 0.22;
const PICK_PX = 14;            // 画面上の当たり判定の半径。見た目が縮んでも変えない
const LABEL_MAX_WIDTH = 240;
const LABEL_GAP = 4;
const CURSOR_LABEL_GAP = 12;
const MATCHED_EDGE_PX = 2.2;

const WHITE = [255, 255, 255];

export function createView(container, { theme }) {
  let currentTheme = theme;
  let showAllLabels = false;
  let viewportHeight = 1;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.NoToneMapping;   // 演出しない。2D と同じ色に見せる
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none';
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.cssText =
    'position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;

  // 視点追従後も減光が気になる場合のみ、受け入れ確認で半球光の強度を調整する。
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 0.62);
  scene.add(key, key.target);  // target の matrixWorld も render 時に更新する。

  const listeners = { nodeclick: [], nodehover: [], bgclick: [], needsframe: [] };
  const emit = (name, arg) => (listeners[name] || []).forEach((fn) => fn(arg));

  let graph = null;
  let pos = null;                // Float32Array(n*3)
  let styles = [];
  let meshes = [];
  let labels = [];
  let labelSizes = [];
  let edgeLines = null;
  let edgeColors = null;
  let edgeHighlights = null;
  let bgRGB = [243, 241, 236];
  let radius = 1;
  let center = new THREE.Vector3();
  let camTween = null;
  let hoverIdx = -1;
  let hoverPointer = null;       // グラフ上のホバーだけが持つ client 座標。結果欄のホバーとは区別する
  let dragMoved = 0;
  let pointerDown = null;
  let controlsMoving = false;

  const geomCache = new Map();
  function geometryFor(shape) {
    if (geomCache.has(shape)) return geomCache.get(shape);
    let g;
    switch (shape) {
      case 'diamond': g = new THREE.OctahedronGeometry(1.25); break;
      case 'hexagon': g = new THREE.CylinderGeometry(1.15, 1.15, 1.0, 6); break;
      case 'roundrect': g = new THREE.BoxGeometry(1.7, 1.7, 1.7); break;
      case 'triangle': g = new THREE.TetrahedronGeometry(1.4); break;
      case 'square': g = new THREE.BoxGeometry(1.6, 1.6, 1.6); break;
      case 'pentagon': g = new THREE.CylinderGeometry(1.15, 1.15, 1.0, 5); break;
      case 'cross': g = new THREE.IcosahedronGeometry(1.2, 0); break;
      default: g = new THREE.SphereGeometry(1, 20, 14);
    }
    g.computeBoundingSphere();
    geomCache.set(shape, g);
    return g;
  }

  // ── サイズ ────────────────────────────────────────────────────────────────
  function nodeScale(i, cur) {
    const s = styles[i];
    const dimScale = currentTheme.vars.dimScale;
    const visibility = Math.max(cur.nodeLit[i], cur.nodeHover[i], cur.nodeNeighbor[i], cur.nodePin[i]);
    const accentScale = Math.max(
      1 + (currentTheme.hoverScale - 1) * cur.nodeHover[i],
      1 + (currentTheme.pinScale - 1) * cur.nodePin[i],
      1 + 0.12 * cur.nodeNeighbor[i]
    );
    return s.radius * NODE_SCALE * radius
      * (dimScale + (1 - dimScale) * visibility)
      * (1 + (currentTheme.hotScale - 1) * cur.nodeHot[i])
      * accentScale;
  }

  // ── 更新 ──────────────────────────────────────────────────────────────────
  function updateNodes(cur) {
    const hotRGB = parseHex(currentTheme.vars.hot);
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      const lit = Math.max(cur.nodeLit[i], cur.nodeNeighbor[i]);
      const accent = Math.max(cur.nodeHover[i], cur.nodePin[i]);
      const s = nodeScale(i, cur);
      m.scale.setScalar(s);

      // 透明度の代わりに背景へ混ぜる。半透明の描画順の破綻を避けるため
      const strength = Math.max(currentTheme.vars.dimAlpha + (1 - currentTheme.vars.dimAlpha) * lit, accent);
      const lifted = mix(styles[i].rgb, WHITE, NODE_LIFT);
      const base = mix(bgRGB, lifted, strength);
      const tinted = accent > 0.02 ? mix(base, hotRGB, accent * 0.45) : base;
      m.material.color.set(toHex(tinted));
      // 背景色を emissive に入れると照明との和で白飛びする。自発光は色そのものを
      // 弱く足し、マットな面の色を保つ
      const glow = 0.025 + 0.075 * cur.nodeHot[i] + 0.08 * accent;
      m.material.emissive.setRGB(
        tinted[0] / 255 * glow,
        tinted[1] / 255 * glow,
        tinted[2] / 255 * glow,
      );
    }
  }

  /** 通常はホバー・接続先・ピンのみ。その他の名前は「すべて表示」で追加する。 */
  function updateLabels(cur) {
    if (!graph) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const focalPixels = rect.height / (2 * Math.tan(FOV * Math.PI / 360));
    const candidates = [];
    let hoverStrength = 0;
    for (let i = 0; i < graph.nodes.length; i++) {
      const hover = cur.nodeHover[i];
      hoverStrength = Math.max(hoverStrength, hover);
      const pointer = i === hoverIdx ? hoverPointer : null;
      const neighbor = cur.nodeNeighbor[i];
      const ambient = showAllLabels ? 0.45 + 0.55 * cur.nodeLit[i] : 0;
      const focus = Math.max(ambient, hover, neighbor, cur.nodePin[i], pointer ? 1 : 0);
      labels[i].element.style.opacity = '0';
      if (focus <= 0.25) {
        continue;
      }
      projected.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).project(camera);
      if (projected.z < -1 || projected.z > 1) {
        continue;
      }
      const x = (projected.x * 0.5 + 0.5) * rect.width;
      const y = (-projected.y * 0.5 + 0.5) * rect.height;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) continue;
      const { w, h } = labelSizes[i];
      const depth = -cameraSpace.copy(meshes[i].position).applyMatrix4(camera.matrixWorldInverse).z;
      const r = meshes[i].geometry.boundingSphere.radius * meshes[i].scale.x * focalPixels / depth;
      const priority = pointer ? 5 : hover > 0.25 ? 4 : neighbor > 0.25 ? 3 : cur.nodePin[i] > 0.25 ? 2 : 1;
      candidates.push({ i, x, y, w, h, r, focus, hover, priority, pointer });
    }
    candidates.sort((a, b) => b.priority - a.priority || b.hover - a.hover || a.i - b.i);
    const placed = [];
    const nodeBoxes = candidates.filter((item) => item.priority >= 3).map((item) => ({
      x0: item.x - item.r, y0: item.y - item.r, x1: item.x + item.r, y1: item.y + item.r,
    }));
    // 操作ヒントと名前の切り替えには重ねない。
    for (const hint of container.parentElement?.querySelectorAll('.stage__hint, .stage__labels') || []) {
      const h = hint.getBoundingClientRect();
      placed.push({ x0: h.left - rect.left, y0: h.top - rect.top,
                    x1: h.right - rect.left, y1: h.bottom - rect.top });
    }
    const overlaps = (box, other) => box.x0 < other.x1 && box.x1 > other.x0
      && box.y0 < other.y1 && box.y1 > other.y0;
    for (const item of candidates) {
      let spot = null;
      if (item.pointer) {
        // 対象名はカーソルの近くを先に確保する。ノードの密集を理由に遠くへ逃がさない。
        const px = item.pointer.x - rect.left, py = item.pointer.y - rect.top;
        const right = px + CURSOR_LABEL_GAP, left = px - CURSOR_LABEL_GAP - item.w;
        const below = py + CURSOR_LABEL_GAP, above = py - CURSOR_LABEL_GAP - item.h;
        for (const [x, y] of [[right, below], [left, below], [right, above], [left, above]]) {
          const box = { x0: x - LABEL_GAP, y0: y - LABEL_GAP,
                        x1: x + item.w + LABEL_GAP, y1: y + item.h + LABEL_GAP };
          if (box.x0 < 0 || box.y0 < 0 || box.x1 > rect.width || box.y1 > rect.height) continue;
          if (placed.some((other) => overlaps(box, other))) continue;
          spot = { x, y, box };
          break;
        }
        if (!spot) {
          const x = Math.max(LABEL_GAP, Math.min(rect.width - item.w - LABEL_GAP, right));
          const y = Math.max(LABEL_GAP, Math.min(rect.height - item.h - LABEL_GAP, below));
          spot = { x, y, box: { x0: x - LABEL_GAP, y0: y - LABEL_GAP,
                               x1: x + item.w + LABEL_GAP, y1: y + item.h + LABEL_GAP } };
        }
      }
      const gap = Math.max(10, item.r + 6);
      const gaps = item.priority >= 3 ? [gap, gap + Math.max(item.w / 2, item.h) + LABEL_GAP] : [gap];
      const spots = gaps.flatMap((distance) => [
        [item.x + distance, item.y - item.h / 2],
        [item.x - distance - item.w, item.y - item.h / 2],
        [item.x - item.w / 2, item.y - distance - item.h],
        [item.x - item.w / 2, item.y + distance],
        [item.x + distance, item.y - distance - item.h],
        [item.x - distance - item.w, item.y - distance - item.h],
        [item.x + distance, item.y + distance],
        [item.x - distance - item.w, item.y + distance],
      ]);
      for (const [x, y] of spots) {
        if (spot) break;
        const box = { x0: x - LABEL_GAP, y0: y - LABEL_GAP,
                      x1: x + item.w + LABEL_GAP, y1: y + item.h + LABEL_GAP };
        if (box.x0 < 0 || box.y0 < 0 || box.x1 > rect.width || box.y1 > rect.height) continue;
        if (placed.some((other) => overlaps(box, other)) || nodeBoxes.some((other) => overlaps(box, other))) continue;
        spot = { x, y, box };
        break;
      }
      // 画面端や密集部でもホバー対象の名前だけは残す。
      if (!spot && item.priority === 4) {
        const x = Math.max(LABEL_GAP, Math.min(rect.width - item.w - LABEL_GAP, spots[0][0]));
        const y = Math.max(LABEL_GAP, Math.min(rect.height - item.h - LABEL_GAP, spots[0][1]));
        spot = { x, y, box: { x0: x - LABEL_GAP, y0: y - LABEL_GAP,
                             x1: x + item.w + LABEL_GAP, y1: y + item.h + LABEL_GAP } };
      }
      if (!spot) continue;
      placed.push(spot.box);
      const label = labels[item.i];
      label.renderOrder = item.priority;
      label.element.firstElementChild.style.transform = `translate(${spot.x - item.x}px, ${spot.y - item.y}px)`;
      label.element.firstElementChild.classList.toggle('is-hover', item.priority >= 4);
      label.element.firstElementChild.classList.toggle('is-neighbor', item.priority === 3);
      const contextAlpha = item.priority >= 3 ? 1 : 1 - hoverStrength * (item.priority === 2 ? 0.35 : 0.6);
      label.element.style.opacity = String(Math.min(1, item.focus) * contextAlpha);
    }
  }

  function updateEdges(cur) {
    if (!edgeLines) return;
    const edgeRGB = parseHex(currentTheme.vars.edge3d);
    const hotRGB = parseHex(currentTheme.vars.hot);
    const hoverRGB = parseHex(currentTheme.vars.fg);
    const idleA = currentTheme.vars.edge3dIdleAlpha;
    const dimA = currentTheme.vars.edge3dDimAlpha;
    const focalPixels = viewportHeight / (2 * Math.tan(FOV * Math.PI / 360));
    let highlighted = 0;
    for (let e = 0; e < graph.edges.length; e++) {
      const lit = cur.edgeLit[e];
      const hover = cur.edgeHover[e];
      const hot = Math.max(cur.edgeHot[e], hover);
      // 辺の色は「背景から --edge へどれだけ寄せるか」で表す（半透明の描画順を避けるため）。
      // 背景が不透明な単色なので 2D の alpha と同じ数式になり、同じトークンで揃う
      const strength = dimA + (idleA - dimA) * lit;
      let c = mix(bgRGB, edgeRGB, strength);
      if (hot > 0.02) c = mix(c, hotRGB, hot);
      // ホバーの接続線はテーマの文字色へ寄せ、金色の検索結果と区別する。
      if (hover > 0.02) c = mix(c, hoverRGB, hover);
      // CSS と同じ sRGB で混ぜた色を、頂点色・インスタンス色用の線形 RGB へ変換する。
      // 生の sRGB 値を渡すと出力時に再び明るくなり、背景へ溶かした暗い線まで浮き上がる。
      edgeColor.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
      const { r, g, b } = edgeColor;
      const o = e * 6;
      edgeColors[o] = r; edgeColors[o + 1] = g; edgeColors[o + 2] = b;
      edgeColors[o + 3] = r; edgeColors[o + 4] = g; edgeColors[o + 5] = b;
      if (hot <= 0.02) continue;
      const { fromIdx, toIdx } = graph.edges[e];
      if (fromIdx === undefined || toIdx === undefined) continue;
      edgeStart.fromArray(pos, fromIdx * 3);
      edgeEnd.fromArray(pos, toIdx * 3);
      edgeDirection.subVectors(edgeEnd, edgeStart);
      const length = edgeDirection.length();
      if (length < 1e-8) continue;
      edgeMidpoint.addVectors(edgeStart, edgeEnd).multiplyScalar(0.5);
      const depth = Math.max(camera.near, -cameraSpace.copy(edgeMidpoint).applyMatrix4(camera.matrixWorldInverse).z);
      // WebGL の linewidth に頼らず細い円柱で描く。中央の奥行きから見かけの太さを揃える。
      const thickness = MATCHED_EDGE_PX * 0.5 * depth / focalPixels * hot;
      edgeRotation.setFromUnitVectors(EDGE_UP, edgeDirection.divideScalar(length));
      edgeScale.set(thickness, length, thickness);
      edgeMatrix.compose(edgeMidpoint, edgeRotation, edgeScale);
      edgeHighlights.setMatrixAt(highlighted, edgeMatrix);
      edgeHighlights.setColorAt(highlighted, edgeColor);
      highlighted++;
    }
    edgeLines.geometry.attributes.color.needsUpdate = true;
    edgeHighlights.count = highlighted;
    edgeHighlights.visible = highlighted > 0;
    edgeHighlights.instanceMatrix.needsUpdate = true;
    if (edgeHighlights.instanceColor) edgeHighlights.instanceColor.needsUpdate = true;
  }

  const EDGE_UP = new THREE.Vector3(0, 1, 0);
  const edgeStart = new THREE.Vector3(), edgeEnd = new THREE.Vector3();
  const edgeDirection = new THREE.Vector3(), edgeMidpoint = new THREE.Vector3();
  const edgeRotation = new THREE.Quaternion(), edgeScale = new THREE.Vector3();
  const edgeMatrix = new THREE.Matrix4(), edgeColor = new THREE.Color();

  function clearEdgeHighlights() {
    if (!edgeHighlights) return;
    scene.remove(edgeHighlights);
    edgeHighlights.geometry.dispose();
    edgeHighlights.material.dispose();
    edgeHighlights.dispose();
    edgeHighlights = null;
  }

  // ── ピッキング。2D と同じ「画面上の一定半径」にする ───────────────────────
  const projected = new THREE.Vector3();
  const cameraSpace = new THREE.Vector3();
  function hitTestAt(sx, sy) {
    if (!graph) return -1;
    const rect = renderer.domElement.getBoundingClientRect();
    let best = -1, bestD = PICK_PX * PICK_PX;
    for (let i = 0; i < graph.nodes.length; i++) {
      projected.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).project(camera);
      if (projected.z > 1) continue;   // カメラの後ろ
      const px = (projected.x * 0.5 + 0.5) * rect.width;
      const py = (-projected.y * 0.5 + 0.5) * rect.height;
      const d2 = (sx - px) * (sx - px) + (sy - py) * (sy - py);
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    return best;
  }

  const localPoint = (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  function onPointerDown(ev) {
    pointerDown = localPoint(ev);
    dragMoved = 0;
    hoverPointer = null;
    emit('needsframe');
  }
  function onPointerMove(ev) {
    const p = localPoint(ev);
    if (pointerDown) {
      dragMoved += Math.abs(p.x - pointerDown.x) + Math.abs(p.y - pointerDown.y);
      pointerDown = p;
      emit('needsframe');
      return;
    }
    const idx = hitTestAt(p.x, p.y);
    hoverPointer = idx >= 0 ? { x: ev.clientX, y: ev.clientY } : null;
    renderer.domElement.style.cursor = idx >= 0 ? 'pointer' : 'grab';
    if (idx !== hoverIdx) {
      hoverIdx = idx;
      emit('nodehover', idx >= 0 ? graph.nodes[idx] : null);
    } else if (idx >= 0) {
      // ホバー先が同じでも、カーソルの移動分だけ名前を追従させる。
      emit('needsframe');
    }
  }
  function onPointerUp(ev) {
    const wasDown = pointerDown;
    pointerDown = null;
    if (!wasDown || dragMoved > 6) return;   // 回転だったのでクリック扱いにしない
    const p = localPoint(ev);
    const idx = hitTestAt(p.x, p.y);
    if (idx >= 0) emit('nodeclick', graph.nodes[idx]);
    else emit('bgclick', null);
  }
  function onPointerLeave() {
    hoverPointer = null;
    if (hoverIdx !== -1) { hoverIdx = -1; emit('nodehover', null); }
  }
  function onPointerCancel() {
    pointerDown = null;
    onPointerLeave();
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  renderer.domElement.addEventListener('pointercancel', onPointerCancel);
  controls.addEventListener('change', () => emit('needsframe'));

  function resize() {
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    viewportHeight = h;
    renderer.setSize(w, h, false);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 書き込みと寸法の読み取りを分け、文字計測はサイズ変更時だけ行う。
    for (const label of labels) {
      label.element.style.maxWidth = `${Math.min(LABEL_MAX_WIDTH, Math.max(1, w - 2 * LABEL_GAP))}px`;
      label.element.style.display = '';
    }
    labelSizes = labels.map((label) => ({
      w: label.element.firstElementChild.offsetWidth,
      h: label.element.firstElementChild.offsetHeight,
    }));
  }
  const ro = new ResizeObserver(() => { resize(); emit('needsframe'); });
  ro.observe(container);

  // 見込む角の縦横どちらが制約になるかを見る。FOV は縦なので、
  // ステージが縦長のときは横が先にあふれる
  function fitDistance() {
    const vFov = (FOV * Math.PI) / 180;
    const aspect = Math.max(0.2, camera.aspect || 1);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    return Math.max(
      (radius * FIT_MARGIN) / Math.tan(vFov / 2),
      (radius * FIT_MARGIN) / Math.tan(hFov / 2)
    );
  }

  function fitCamera() {
    const dist = fitDistance();
    // 真正面ではなく少しだけ見下ろす。奥行きがあることが一目で分かる程度の傾き。
    // y は必ず正（カメラを上に置く）。負にするとグラフを下から見上げることになり、
    // 傾きが逆向きになって「上下が反転している」ように見える
    const dir = new THREE.Vector3(0, TILT, 1).normalize().multiplyScalar(dist);
    return { position: center.clone().add(dir), target: center.clone() };
  }

  function applyBackground() {
    bgRGB = parseHex(currentTheme.vars.bgStage);
    scene.background = new THREE.Color(currentTheme.vars.bgStage);
  }

  return {
    kind: '3d',

    setGraph(g, layout) {
      graph = g;
      pos = layout.pos3;
      styles = g.nodes.map((node) => currentTheme.forLabel(node.label));
      applyBackground();

      // 位置の広がりからカメラの距離を決める。
      // 注視点はバウンディングボックスの中心ではなく重心にする。
      // 離れた小さな塊があるとボックスの中心が実際の質量から外れ、
      // グラフが画面の隅に寄って余白ができる
      center.set(0, 0, 0);
      for (let i = 0; i < g.nodes.length; i++) {
        center.x += pos[i * 3]; center.y += pos[i * 3 + 1]; center.z += pos[i * 3 + 2];
      }
      center.divideScalar(Math.max(1, g.nodes.length));

      // 半径は対角の半分（getSize().length()/2）だと平べったい分布で過大評価になり、
      // カメラが必要以上に引いてグラフが小さく収まる。重心から一番遠いノードまでを使う
      let far = 0;
      for (let i = 0; i < g.nodes.length; i++) {
        const dx = pos[i * 3] - center.x;
        const dy = pos[i * 3 + 1] - center.y;
        const dz = pos[i * 3 + 2] - center.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > far) far = d;
      }
      radius = Math.max(0.2, far);

      // ノードは 1 つずつ Mesh にする。InstancedMesh ではインスタンスごとの色が扱いにくい
      for (const label of labels) label.removeFromParent();
      for (const m of meshes) { scene.remove(m); m.material.dispose(); }
      meshes = [];
      labels = [];
      for (let i = 0; i < g.nodes.length; i++) {
        const mat = new THREE.MeshStandardMaterial({
          roughness: 0.85, metalness: 0.0, flatShading: false,
        });
        const mesh = new THREE.Mesh(geometryFor(styles[i].shape), mat);
        mesh.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        scene.add(mesh);
        meshes.push(mesh);

        const el = document.createElement('div');
        el.className = 'graph-label-anchor';
        const text = document.createElement('span');
        text.className = 'graph-label';
        text.textContent = g.nodes[i].name;
        el.append(text);
        labelRenderer.domElement.append(el);
        const label = new CSS2DObject(el);
        label.center.set(0, 0);
        mesh.add(label);
        labels.push(label);
      }

      // 辺は1本の LineSegments。頂点色に「背景へ混ぜた色」を入れて濃淡を出す
      if (edgeLines) { scene.remove(edgeLines); edgeLines.geometry.dispose(); }
      const positions = new Float32Array(g.edges.length * 6);
      edgeColors = new Float32Array(g.edges.length * 6);
      for (let e = 0; e < g.edges.length; e++) {
        const a = g.edges[e].fromIdx, b = g.edges[e].toIdx;
        if (a === undefined || b === undefined) continue;
        positions.set([pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2],
                       pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]], e * 6);
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3));
      edgeLines = new THREE.LineSegments(geom,
        new THREE.LineBasicMaterial({ vertexColors: true }));
      scene.add(edgeLines);
      clearEdgeHighlights();
      edgeHighlights = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshBasicMaterial(), g.edges.length);
      edgeHighlights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      edgeHighlights.count = 0;
      edgeHighlights.frustumCulled = false;
      scene.add(edgeHighlights);

      resize();
      const fit = fitCamera();
      camera.position.copy(fit.position);
      controls.target.copy(fit.target);
      controlsMoving = controls.update();
    },

    setShowAllLabels(show) { showAllLabels = !!show; },

    setTheme(next) {
      currentTheme = next;
      applyBackground();
      if (!graph) return;
      styles = graph.nodes.map((node) => currentTheme.forLabel(node.label));
    },

    frame(dt, cur) {
      if (camTween) {
        camTween.t = Math.min(1, camTween.t + dt / CAM_TWEEN_SEC);
        const e = 1 - Math.pow(1 - camTween.t, 3);
        camera.position.lerpVectors(camTween.from.position, camTween.to.position, e);
        controls.target.lerpVectors(camTween.from.target, camTween.to.target, e);
        if (camTween.t >= 1) camTween = null;
      }
      controlsMoving = controls.update();
      camera.updateMatrixWorld();
      // 回転・パン・フォーカス中も、注視点をカメラのやや右上から照らす。
      key.position.copy(LIGHT_OFFSET).applyQuaternion(camera.quaternion).add(controls.target);
      key.target.position.copy(controls.target);
      updateNodes(cur);
      updateEdges(cur);
      renderer.render(scene, camera);
      updateLabels(cur);
      labelRenderer.render(scene, camera);
    },

    resize,

    resetCamera() {
      camTween = {
        from: { position: camera.position.clone(), target: controls.target.clone() },
        to: fitCamera(), t: 0,
      };
    },

    focusNode(idx) {
      if (!graph || idx < 0) return;
      const p = new THREE.Vector3(pos[idx * 3], pos[idx * 3 + 1], pos[idx * 3 + 2]);
      const dir = camera.position.clone().sub(controls.target).normalize();
      camTween = {
        from: { position: camera.position.clone(), target: controls.target.clone() },
        to: { position: p.clone().add(dir.multiplyScalar(radius * FOCUS_DISTANCE)), target: p },
        t: 0,
      };
    },

    isCameraMoving: () => camTween !== null || controlsMoving,

    getCameraState: () => ({
      position: camera.position.toArray(),
      target: controls.target.toArray(),
    }),

    /** 2D の {cx, cy, k} を渡されても受け付ける。切り替えを「カメラの移動」に見せるため。 */
    setCameraState(s) {
      if (!s) return;
      if (Array.isArray(s.position) && Array.isArray(s.target)) {
        camera.position.fromArray(s.position);
        controls.target.fromArray(s.target);
      } else if (Number.isFinite(s.cx) && Number.isFinite(s.k)) {
        const zoom = Number.isFinite(s.zoom) ? Math.max(0.5, Math.min(3, s.zoom)) : 1;
        const dist = fitDistance() / zoom;
        controls.target.set(s.cx, s.cy, 0);
        camera.position.set(s.cx, s.cy + dist * TILT, center.z + dist);
      }
      controlsMoving = controls.update();
    },

    hitTest(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      const idx = hitTestAt(clientX - rect.left, clientY - rect.top);
      return idx >= 0 ? { kind: 'node', idx } : null;
    },

    on(name, fn) {
      if (!listeners[name]) listeners[name] = [];
      listeners[name].push(fn);
    },

    destroy() {
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('pointercancel', onPointerCancel);
      for (const m of meshes) { scene.remove(m); m.material.dispose(); }
      for (const g of geomCache.values()) g.dispose();
      geomCache.clear();
      if (edgeLines) { scene.remove(edgeLines); edgeLines.geometry.dispose(); edgeLines.material.dispose(); }
      clearEdgeHighlights();
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
      graph = null;
    },
  };
}
