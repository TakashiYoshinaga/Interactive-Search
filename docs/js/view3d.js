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
// theme.js の半径（2D ではピクセル。最大 11 / 最小 4.5）をワールド単位に落とす係数。
// 2D は fit 時に「最大のノードが約 11px」＝レイアウトの広がりの 2〜3% になるので、
// 3D もその見え方に揃える。ここを大きくするとノードが互いに埋まり、辺も構造も見えなくなる。
// 形ごとのジオメトリ自体が半径 1.2〜1.7 を持っているぶんも見込んでいる。
const NODE_SCALE = 0.006;
const EDGE_MIN = 0.10;         // 減衰した辺をどこまで背景に寄せるか
const EDGE_IDLE = 0.42;
const CAM_TWEEN_SEC = 0.5;
const FOCUS_DISTANCE = 1.55;
const PICK_PX = 14;            // 画面上の当たり判定の半径。見た目が縮んでも変えない
const LABEL_H = 15;
const LABEL_GAP = 3;

export function createView(container, { theme }) {
  let currentTheme = theme;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.NoToneMapping;   // 演出しない。2D と同じ色に見せる
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none';
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.cssText =
    'position:absolute;inset:0;pointer-events:none;overflow:hidden';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(1.2, 1.6, 1.4);
  scene.add(key);

  const listeners = { nodeclick: [], nodehover: [], bgclick: [], needsframe: [] };
  const emit = (name, arg) => (listeners[name] || []).forEach((fn) => fn(arg));

  let graph = null;
  let pos = null;                // Float32Array(n*3)
  let styles = [];
  let meshes = [];
  let labels = [];
  let edgeLines = null;
  let edgeColors = null;
  let bgRGB = [243, 241, 236];
  let radius = 1;
  let center = new THREE.Vector3();
  let camTween = null;
  let hoverIdx = -1;
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
    geomCache.set(shape, g);
    return g;
  }

  // ── サイズ ────────────────────────────────────────────────────────────────
  function nodeScale(i, cur) {
    const s = styles[i];
    const dimScale = currentTheme.vars.dimScale;
    const accentScale = Math.max(
      1 + (currentTheme.hoverScale - 1) * cur.nodeHover[i],
      1 + (currentTheme.pinScale - 1) * cur.nodePin[i]
    );
    return s.radius * NODE_SCALE * radius
      * (dimScale + (1 - dimScale) * cur.nodeLit[i])
      * (1 + (currentTheme.hotScale - 1) * cur.nodeHot[i])
      * accentScale;
  }

  // ── 更新 ──────────────────────────────────────────────────────────────────
  function updateNodes(cur) {
    const hotRGB = parseHex(currentTheme.vars.hot);
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      const lit = cur.nodeLit[i];
      const accent = Math.max(cur.nodeHover[i], cur.nodePin[i]);
      const s = nodeScale(i, cur);
      m.scale.setScalar(s);

      // 透明度の代わりに背景へ混ぜる。半透明の描画順の破綻を避けるため
      const strength = Math.max(currentTheme.vars.dimAlpha + (1 - currentTheme.vars.dimAlpha) * lit, accent);
      const base = mix(bgRGB, styles[i].rgb, strength);
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

  /** 強調中のラベルを画面空間で間引く。ピンとホバーは常に残す。 */
  function updateLabels(cur) {
    if (!graph) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const candidates = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      const accent = Math.max(cur.nodeHover[i], cur.nodePin[i]);
      const focus = Math.max(cur.nodeHot[i], accent);
      if (focus <= 0.25) {
        labels[i].element.style.opacity = '0';
        continue;
      }
      projected.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).project(camera);
      if (projected.z < -1 || projected.z > 1) {
        labels[i].element.style.opacity = '0';
        continue;
      }
      const x = (projected.x * 0.5 + 0.5) * rect.width;
      const y = (-projected.y * 0.5 + 0.5) * rect.height;
      const w = Math.min(rect.width * 0.32, Math.max(32, graph.nodes[i].name.length * 6.2));
      candidates.push({ i, x, y, w, focus, accent, priority: accent * 10 + cur.nodeHot[i] });
    }
    candidates.sort((a, b) => b.priority - a.priority || a.i - b.i);
    const placed = [];
    for (const item of candidates) {
      const box = {
        x0: item.x - item.w / 2 + 8 - LABEL_GAP,
        x1: item.x + item.w / 2 + 8 + LABEL_GAP,
        y0: item.y - LABEL_H / 2 - LABEL_GAP,
        y1: item.y + LABEL_H / 2 + LABEL_GAP,
      };
      const collision = placed.some((other) =>
        box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0
      );
      const visible = item.accent > 0.25 || !collision;
      labels[item.i].element.style.opacity = visible ? String(Math.min(1, item.focus)) : '0';
      if (visible) placed.push(box);
    }
  }

  function updateEdges(cur) {
    if (!edgeLines) return;
    const dimRGB = parseHex(currentTheme.vars.dim);
    const hotRGB = parseHex(currentTheme.vars.hot);
    for (let e = 0; e < graph.edges.length; e++) {
      const lit = cur.edgeLit[e];
      const hot = cur.edgeHot[e];
      const strength = EDGE_MIN + (EDGE_IDLE - EDGE_MIN) * lit;
      let c = mix(bgRGB, dimRGB, strength);
      if (hot > 0.02) c = mix(c, hotRGB, hot);
      const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
      const o = e * 6;
      edgeColors[o] = r; edgeColors[o + 1] = g; edgeColors[o + 2] = b;
      edgeColors[o + 3] = r; edgeColors[o + 4] = g; edgeColors[o + 5] = b;
    }
    edgeLines.geometry.attributes.color.needsUpdate = true;
  }

  // ── ピッキング。2D と同じ「画面上の一定半径」にする ───────────────────────
  const projected = new THREE.Vector3();
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

  function onPointerDown(ev) { pointerDown = localPoint(ev); dragMoved = 0; }
  function onPointerMove(ev) {
    const p = localPoint(ev);
    if (pointerDown) {
      dragMoved += Math.abs(p.x - pointerDown.x) + Math.abs(p.y - pointerDown.y);
      pointerDown = p;
      emit('needsframe');
      return;
    }
    const idx = hitTestAt(p.x, p.y);
    renderer.domElement.style.cursor = idx >= 0 ? 'pointer' : 'grab';
    if (idx !== hoverIdx) {
      hoverIdx = idx;
      emit('nodehover', idx >= 0 ? graph.nodes[idx] : null);
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
    if (hoverIdx !== -1) { hoverIdx = -1; emit('nodehover', null); }
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  controls.addEventListener('change', () => emit('needsframe'));

  function resize() {
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    renderer.setSize(w, h, false);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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
    // 真正面ではなく少しだけ見下ろす。奥行きがあることが一目で分かる程度の傾き
    const dir = new THREE.Vector3(0, -0.22, 1).normalize().multiplyScalar(dist);
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
        el.textContent = g.nodes[i].name;
        el.style.cssText = 'font:11px system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif;'
          + `color:${currentTheme.vars.fg};white-space:nowrap;opacity:0;`
          + 'transform:translateX(10px);text-shadow:0 0 3px ' + currentTheme.vars.bgStage
          + ',0 0 3px ' + currentTheme.vars.bgStage + ';pointer-events:none';
        const label = new CSS2DObject(el);
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

      resize();
      const fit = fitCamera();
      camera.position.copy(fit.position);
      controls.target.copy(fit.target);
      controlsMoving = controls.update();
    },

    setTheme(next) {
      currentTheme = next;
      applyBackground();
      if (!graph) return;
      styles = graph.nodes.map((node) => currentTheme.forLabel(node.label));
      for (const label of labels) {
        label.element.style.color = currentTheme.vars.fg;
        label.element.style.textShadow =
          `0 0 3px ${currentTheme.vars.bgStage},0 0 3px ${currentTheme.vars.bgStage}`;
      }
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
        camera.position.set(s.cx, s.cy - dist * 0.25, center.z + dist);
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
      for (const m of meshes) { scene.remove(m); m.material.dispose(); }
      for (const g of geomCache.values()) g.dispose();
      geomCache.clear();
      if (edgeLines) { scene.remove(edgeLines); edgeLines.geometry.dispose(); edgeLines.material.dispose(); }
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
      graph = null;
    },
  };
}
