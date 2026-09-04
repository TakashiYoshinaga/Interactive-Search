/**
 * 2D の描画。Canvas 2D を自前で回す。
 *
 * ビューはハイライト状態を持たない。frame(dt, cur) で渡される anim.js の
 * バッファを読むだけ。3D 版（view3d.js）も同じインタフェースを実装するので、
 * app.js は無改造で切り替えられる。
 *
 * 位置は layout.js が焼いたものをそのまま使い、絶対に動かさない。
 */

const FIT_PAD = 0.10;          // 収めるときの余白（画面の割合）
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 12;
const ZOOM_STEP = 1.0015;      // ホイール1ノッチあたり
const DRAG_SLOP = 4;           // これ以上動いたらクリックではなくパン
const CAM_TWEEN_SEC = 0.45;
const ALWAYS_LABEL_MAX = 16;   // 件数がこれ以下のラベルは常にラベルを出す
const ZOOM_LABEL_AT = 1.6;     // それ以外は fit の何倍まで寄ったら出すか
const EDGE_MIN_ALPHA = 0.07;   // 減衰した辺。0 にすると「他も存在している」が消える
const LABEL_H = 15;           // ラベル1行の高さ（衝突判定用）
const LABEL_FONT = '11px system-ui, -apple-system, "Segoe UI", "Noto Sans JP", sans-serif';

export function createView(container, { theme }) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let currentTheme = theme;
  let graph = null;
  let pos = null;              // Float32Array(n*2)
  let styles = [];             // ノードごとの theme スタイル
  let labelW = [];             // ラベル幅のキャッシュ（毎フレーム measureText しない）
  let alwaysLabel = [];        // 常時ラベルを出すか

  let W = 1, H = 1, dpr = 1;
  const cam = { cx: 0, cy: 0, k: 1 };
  let kFit = 1;
  let camTween = null;

  const listeners = { nodeclick: [], nodehover: [], bgclick: [], needsframe: [] };
  const emit = (name, arg) => listeners[name].forEach((fn) => fn(arg));

  let hoverIdx = -1;
  let dragging = false;
  let dragMoved = 0;
  let lastPointer = { x: 0, y: 0 };

  // ── 座標変換 ──────────────────────────────────────────────────────────────
  const toScreenX = (wx) => (wx - cam.cx) * cam.k + W / 2;
  const toScreenY = (wy) => H / 2 - (wy - cam.cy) * cam.k;
  const toWorldX = (sx) => (sx - W / 2) / cam.k + cam.cx;
  const toWorldY = (sy) => (H / 2 - sy) / cam.k + cam.cy;
  const zoomScale = () => Math.max(0.6, Math.min(3, cam.k / kFit));

  // ── 大きさ ────────────────────────────────────────────────────────────────
  function drawRadius(i, cur) {
    const s = styles[i];
    const lit = cur.nodeLit[i];
    const hot = cur.nodeHot[i];
    const accent = Math.max(cur.nodeHover[i], cur.nodePin[i]);
    const accentScale = Math.max(
      1 + (currentTheme.hoverScale - 1) * cur.nodeHover[i],
      1 + (currentTheme.pinScale - 1) * cur.nodePin[i]
    );
    const dimScale = currentTheme.vars.dimScale;
    return s.radius * zoomScale()
      * (dimScale + (1 - dimScale) * lit)
      * (1 + (currentTheme.hotScale - 1) * hot)
      * (accent > 0 ? accentScale : 1);
  }

  /** 当たり判定は見た目と別。減衰して縮んだノードもピン留めできないと困る。 */
  function pickRadius(i) {
    return Math.max(styles[i].pickRadius * zoomScale(), 11);
  }

  // ── 形 ────────────────────────────────────────────────────────────────────
  function tracePath(shape, x, y, r) {
    ctx.beginPath();
    switch (shape) {
      case 'diamond':
        ctx.moveTo(x, y - r * 1.18); ctx.lineTo(x + r * 1.18, y);
        ctx.lineTo(x, y + r * 1.18); ctx.lineTo(x - r * 1.18, y);
        ctx.closePath();
        break;
      case 'hexagon': {
        const rr = r * 1.1;
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i - Math.PI / 2;
          const px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      }
      case 'roundrect': {
        const s = r * 0.94, rad = Math.max(1.5, r * 0.34);
        ctx.roundRect(x - s, y - s, s * 2, s * 2, rad);
        break;
      }
      case 'triangle': {
        const rr = r * 1.25;
        ctx.moveTo(x, y - rr);
        ctx.lineTo(x + rr * 0.87, y + rr * 0.5);
        ctx.lineTo(x - rr * 0.87, y + rr * 0.5);
        ctx.closePath();
        break;
      }
      case 'square': {
        const s = r * 0.92;
        ctx.rect(x - s, y - s, s * 2, s * 2);
        break;
      }
      case 'pentagon': {
        const rr = r * 1.12;
        for (let i = 0; i < 5; i++) {
          const a = (2 * Math.PI / 5) * i - Math.PI / 2;
          const px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      }
      default:
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  // ── 描画 ──────────────────────────────────────────────────────────────────
  function draw(cur) {
    const v = currentTheme.vars;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!graph) return;

    const n = graph.nodes.length;

    // 1) 辺。まず全部を淡く
    ctx.lineCap = 'round';
    for (let e = 0; e < graph.edges.length; e++) {
      const edge = graph.edges[e];
      const a = edge.fromIdx, b = edge.toIdx;
      if (a === undefined || b === undefined) continue;
      const lit = cur.edgeLit[e];
      const alpha = EDGE_MIN_ALPHA + (v.edgeIdleAlpha - EDGE_MIN_ALPHA) * lit;
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = v.dim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(toScreenX(pos[a * 2]), toScreenY(pos[a * 2 + 1]));
      ctx.lineTo(toScreenX(pos[b * 2]), toScreenY(pos[b * 2 + 1]));
      ctx.stroke();
    }

    // 2) 一致した辺。金で太く、向きが分かるように矢を付ける
    for (let e = 0; e < graph.edges.length; e++) {
      const hot = cur.edgeHot[e];
      if (hot <= 0.02) continue;
      const edge = graph.edges[e];
      const a = edge.fromIdx, b = edge.toIdx;
      if (a === undefined || b === undefined) continue;
      const x1 = toScreenX(pos[a * 2]), y1 = toScreenY(pos[a * 2 + 1]);
      const x2 = toScreenX(pos[b * 2]), y2 = toScreenY(pos[b * 2 + 1]);
      ctx.globalAlpha = hot;
      ctx.strokeStyle = v.hot;
      ctx.lineWidth = 1 + 1.6 * hot;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      drawArrow(x1, y1, x2, y2, drawRadius(b, cur) + 2, 5.5 * hot, v.hot, hot);
    }

    // 3) ノード。減衰しているものを先に描いて、強調が上に来るようにする
    const order = Array.from({ length: n }, (_, i) => i)
      .sort((p, q) => (cur.nodeLit[p] + cur.nodeHot[p]) - (cur.nodeLit[q] + cur.nodeHot[q]));

    for (const i of order) {
      const lit = cur.nodeLit[i];
      const accent = Math.max(cur.nodeHover[i], cur.nodePin[i]);
      const alpha = Math.max(v.dimAlpha + (1 - v.dimAlpha) * lit, accent);
      if (alpha <= 0.02) continue;
      const x = toScreenX(pos[i * 2]), y = toScreenY(pos[i * 2 + 1]);
      const r = drawRadius(i, cur);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = currentTheme.rampAt(styles[i], lit);
      tracePath(styles[i].shape, x, y, r);
      ctx.fill();

      if (accent > 0.02) {
        ctx.globalAlpha = accent;
        ctx.strokeStyle = v.hot;
        ctx.lineWidth = 1.6;
        tracePath(styles[i].shape, x, y, r + 2.5);
        ctx.stroke();
      }
    }

    // 4) ラベル。全部出すと文字の雲になるので、強調・ホバー・ピンと、
    //    件数の少ないラベルだけ。残りは寄ったときに出す。
    //    レイアウト時の重なり解消だけでは足りない（ズームで文字の相対サイズが変わる）ので、
    //    画面空間でも置き場所をずらして衝突を避ける。
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'middle';
    const zoomedIn = cam.k > kFit * ZOOM_LABEL_AT;

    const wanted = [];
    for (let i = 0; i < n; i++) {
      const focus = Math.max(cur.nodeHot[i], cur.nodeHover[i], cur.nodePin[i]);
      const ambient = (alwaysLabel[i] || zoomedIn) ? cur.nodeLit[i] * 0.75 : 0;
      const a = Math.max(focus, ambient);
      if (a <= 0.05) continue;
      const x = toScreenX(pos[i * 2]), y = toScreenY(pos[i * 2 + 1]);
      const w = labelW[i] || 0;
      if (x + w < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      // ホバーとピンが最優先。次に一致したノード、最後に常時表示
      const prio = cur.nodeHover[i] * 3 + cur.nodePin[i] * 2 + cur.nodeHot[i];
      wanted.push({ i, a, x, y, w, prio, focus, r: drawRadius(i, cur) });
    }
    wanted.sort((p, q) => q.prio - p.prio);

    const placed = [];
    const hits = (b) => placed.some((o) =>
      b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);

    for (const item of wanted) {
      const gap = item.r + 5;
      const half = LABEL_H / 2;
      // 右 → 左 → 上 → 下 の順に置ける場所を探す
      const spots = [
        [item.x + gap, item.y],
        [item.x - gap - item.w, item.y],
        [item.x - item.w / 2, item.y - gap - half],
        [item.x - item.w / 2, item.y + gap + half],
      ];
      let spot = null;
      for (const [tx, ty] of spots) {
        const box = { x0: tx - 2, y0: ty - half, x1: tx + item.w + 2, y1: ty + half };
        if (!hits(box)) { spot = [tx, ty]; placed.push(box); break; }
      }
      // ホバーとピンは押しのけてでも出す。それ以外は諦める（文字の雲を作らない）
      if (!spot) {
        if (item.prio < 2) continue;
        spot = spots[0];
        placed.push({ x0: spot[0] - 2, y0: spot[1] - half, x1: spot[0] + item.w + 2, y1: spot[1] + half });
      }
      ctx.globalAlpha = item.a * 0.92;
      ctx.strokeStyle = v.bgStage;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeText(graph.nodes[item.i].name, spot[0], spot[1]);
      ctx.fillStyle = item.focus > 0.5 ? v.fg : v.fgMute;
      ctx.fillText(graph.nodes[item.i].name, spot[0], spot[1]);
    }

    ctx.globalAlpha = 1;
  }

  function drawArrow(x1, y1, x2, y2, back, size, color, alpha) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const tipX = x2 - ux * back, tipY = y2 - uy * back;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size + -uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
    ctx.lineTo(tipX - ux * size - -uy * size * 0.55, tipY - uy * size - ux * size * 0.55);
    ctx.closePath();
    ctx.fill();
  }

  // ── 当たり判定 ────────────────────────────────────────────────────────────
  function hitTestAt(sx, sy) {
    if (!graph) return -1;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < graph.nodes.length; i++) {
      const dx = sx - toScreenX(pos[i * 2]);
      const dy = sy - toScreenY(pos[i * 2 + 1]);
      const d2 = dx * dx + dy * dy;
      const r = pickRadius(i);
      if (d2 <= r * r && d2 < bestD) { bestD = d2; best = i; }
    }
    return best;
  }

  const localPoint = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  // ── 入力 ──────────────────────────────────────────────────────────────────
  function onPointerDown(ev) {
    canvas.setPointerCapture(ev.pointerId);
    dragging = true;
    dragMoved = 0;
    lastPointer = localPoint(ev);
    canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(ev) {
    const p = localPoint(ev);
    if (dragging) {
      const dx = p.x - lastPointer.x, dy = p.y - lastPointer.y;
      dragMoved += Math.abs(dx) + Math.abs(dy);
      cam.cx -= dx / cam.k;
      cam.cy += dy / cam.k;
      camTween = null;
      lastPointer = p;
      emit('needsframe');
      return;
    }
    const idx = hitTestAt(p.x, p.y);
    canvas.style.cursor = idx >= 0 ? 'pointer' : 'grab';
    if (idx !== hoverIdx) {
      hoverIdx = idx;
      emit('nodehover', idx >= 0 ? graph.nodes[idx] : null);
    }
  }

  function onPointerUp(ev) {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = 'grab';
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* すでに外れている */ }
    if (dragMoved > DRAG_SLOP) return;      // パンだったのでクリック扱いにしない
    const p = localPoint(ev);
    const idx = hitTestAt(p.x, p.y);
    if (idx >= 0) emit('nodeclick', graph.nodes[idx]);
    else emit('bgclick', null);
  }

  function onPointerLeave() {
    if (hoverIdx !== -1) { hoverIdx = -1; emit('nodehover', null); }
    canvas.style.cursor = 'grab';
  }

  function onWheel(ev) {
    ev.preventDefault();
    const p = localPoint(ev);
    const wx = toWorldX(p.x), wy = toWorldY(p.y);
    // トラックパッドのピンチは ctrlKey が立つ。行単位のスクロールも吸収する
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? H : 1;
    const factor = Math.pow(ZOOM_STEP, -ev.deltaY * unit * (ev.ctrlKey ? 2.2 : 1));
    cam.k = Math.max(kFit * ZOOM_MIN, Math.min(kFit * ZOOM_MAX, cam.k * factor));
    // ポインタの下のワールド座標が動かないように中心を寄せる
    cam.cx = wx - (p.x - W / 2) / cam.k;
    cam.cy = wy + (p.y - H / 2) / cam.k;
    camTween = null;
    emit('needsframe');
  }

  // ── 収める ────────────────────────────────────────────────────────────────
  function computeFit() {
    if (!graph || !graph.nodes.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < graph.nodes.length; i++) {
      x0 = Math.min(x0, pos[i * 2]); x1 = Math.max(x1, pos[i * 2]);
      y0 = Math.min(y0, pos[i * 2 + 1]); y1 = Math.max(y1, pos[i * 2 + 1]);
    }
    const spanX = Math.max(1e-3, x1 - x0);
    const spanY = Math.max(1e-3, y1 - y0);
    kFit = Math.min(W * (1 - FIT_PAD * 2) / spanX, H * (1 - FIT_PAD * 2) / spanY);
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k: kFit };
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const before = kFit;
    const fit = computeFit();
    if (fit && before) cam.k *= kFit / before;   // 収まり具合を保ったままリサイズ
    else if (fit) Object.assign(cam, fit);
  }

  const ro = new ResizeObserver(() => { resize(); emit('needsframe'); });
  ro.observe(container);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // ── 公開インタフェース ────────────────────────────────────────────────────
  return {
    kind: '2d',

    setGraph(g, layout) {
      graph = g;
      pos = layout.pos2;
      styles = g.nodes.map((node) => currentTheme.forLabel(node.label));
      ctx.font = LABEL_FONT;
      labelW = g.nodes.map((node) => ctx.measureText(node.name).width);
      alwaysLabel = g.nodes.map((node) => (g.labelTotals[node.label] || 0) <= ALWAYS_LABEL_MAX);
      resize();
      const fit = computeFit();
      if (fit) Object.assign(cam, fit);
    },

    setTheme(next) {
      currentTheme = next;
      if (graph) styles = graph.nodes.map((node) => currentTheme.forLabel(node.label));
    },

    frame(dt, cur) {
      if (camTween) {
        camTween.t = Math.min(1, camTween.t + dt / CAM_TWEEN_SEC);
        // 緩やかに止まる ease-out
        const e = 1 - (1 - camTween.t) * (1 - camTween.t) * (1 - camTween.t);
        cam.cx = camTween.from.cx + (camTween.to.cx - camTween.from.cx) * e;
        cam.cy = camTween.from.cy + (camTween.to.cy - camTween.from.cy) * e;
        cam.k = camTween.from.k + (camTween.to.k - camTween.from.k) * e;
        if (camTween.t >= 1) camTween = null;
      }
      draw(cur);
    },

    resize,

    resetCamera() {
      const fit = computeFit();
      if (fit) camTween = { from: { ...cam }, to: fit, t: 0 };
    },

    focusNode(idx) {
      if (!graph || idx < 0 || idx >= graph.nodes.length) return;
      camTween = {
        from: { ...cam },
        to: { cx: pos[idx * 2], cy: pos[idx * 2 + 1], k: Math.max(cam.k, kFit * 1.8) },
        t: 0,
      };
    },

    isCameraMoving: () => camTween !== null,
    getCameraState: () => ({ ...cam }),
    setCameraState(s) {
      if (!s) return;
      if (Number.isFinite(s.cx)) cam.cx = s.cx;
      if (Number.isFinite(s.cy)) cam.cy = s.cy;
      if (Number.isFinite(s.k)) cam.k = s.k;
      camTween = null;
    },

    hitTest(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const idx = hitTestAt(clientX - rect.left, clientY - rect.top);
      return idx >= 0 ? { kind: 'node', idx } : null;
    },

    on(name, fn) {
      if (!listeners[name]) listeners[name] = [];
      listeners[name].push(fn);
    },

    destroy() {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.remove();
      graph = null;
    },
  };
}
