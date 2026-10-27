// Topo map on a canvas: background linework and text from the drawing, trees coloured by status.
// World coordinates are metres relative to the pack origin (x east, y north).

export const STATUS_COLORS = { todo: "#e8590c", partial: "#f2b100", done: "#2b8a3e", missing: "#868e96" };
const TAP_RADIUS = 26;      // px: how close a tap must be to a tree
const MIN_TEXT_PX = 7;      // background text smaller than this on screen is not drawn

export class TopoMap {
  constructor(canvas, { onTap, onMove } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onTap = onTap || (() => {});
    this.onMove = onMove || (() => {});
    this.scale = 1;           // px per metre
    this.cx = 0;              // world point at the centre of the screen
    this.cy = 0;
    this.trees = [];          // [{key, label, x, y, status, isNew}]
    this.selected = null;
    this.location = null;     // {x, y, acc}
    this.layers = [];
    this.texts = [];
    this.points = [];
    this.pointers = new Map();
    this.frame = 0;
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setPack(pack) {
    this.layers = pack.layers.map((layer) => {
      const path = new Path2D();
      for (const line of layer.lines) {
        path.moveTo(line[0], line[1]);
        for (let i = 2; i < line.length; i += 2) path.lineTo(line[i], line[i + 1]);
      }
      return { name: layer.name, color: layer.color, path };
    });
    this.texts = pack.texts;
    this.points = pack.points;
    this.pointColors = pack.layers.map((l) => l.color);
    this.fit(pack.view);
  }

  setTrees(trees) {
    this.trees = trees;
    this.draw();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    if (!this.fitted && this.pendingFit) this.fit(this.pendingFit);
    this.draw();
  }

  fit([x0, y0, x1, y1]) {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) {
      this.pendingFit = [x0, y0, x1, y1];
      return;
    }
    this.fitted = true;
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    this.scale = Math.min(w / Math.max(x1 - x0, 1), h / Math.max(y1 - y0, 1));
    this.draw();
  }

  // shiftPx moves the point left of the screen centre, e.g. to keep it clear of a side panel
  centerOn(x, y, minScale = 0, shiftPx = 0) {
    this.scale = Math.max(this.scale, minScale);
    this.cx = x + shiftPx / this.scale;
    this.cy = y;
    this.draw();
  }

  zoomBy(factor, sx, sy) {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (sx === undefined) { sx = w / 2; sy = h / 2; }
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.min(Math.max(this.scale * factor, 0.02), 400);
    this.cx = wx - (sx - w / 2) / this.scale;
    this.cy = wy + (sy - h / 2) / this.scale;
    this.draw();
  }

  toScreen(x, y) {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    return [(x - this.cx) * this.scale + w / 2, (this.cy - y) * this.scale + h / 2];
  }

  toWorld(sx, sy) {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    return [(sx - w / 2) / this.scale + this.cx, this.cy - (sy - h / 2) / this.scale];
  }

  draw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.snap) this.renderMoving();
      else this.render();
    });
  }

  // While a finger or the mouse wheel moves the map, the last full drawing is moved and scaled as a picture,
  // which is fast on slow tablets; the full drawing follows when the gesture ends.
  startGesture() {
    if (this.snap) return;
    if (!this.fresh) this.render();
    this.snapshot = this.snapshot || document.createElement("canvas");
    this.snapshot.width = this.canvas.width;
    this.snapshot.height = this.canvas.height;
    this.snapshot.getContext("2d").drawImage(this.canvas, 0, 0);
    this.snap = { scale: this.scale, cx: this.cx, cy: this.cy };
  }

  endGesture() {
    this.snap = null;
    this.draw();
  }

  renderMoving() {
    const { ctx, canvas, dpr = 1, snap } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const k = this.scale / snap.scale;
    const ox = w / 2 - (w / 2) * k + (snap.cx - this.cx) * this.scale;
    const oy = h / 2 - (h / 2) * k + (this.cy - snap.cy) * this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fbfcfb";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.snapshot, ox, oy, w * k, h * k);
    this.fresh = false;
  }

  render() {
    this.fresh = true;
    const { ctx, canvas, dpr = 1 } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fbfcfb";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const s = this.scale * dpr;
    const [vx0, vy1] = this.toWorld(0, 0);
    const [vx1, vy0] = this.toWorld(w, h);

    // background linework in world coordinates
    ctx.setTransform(s, 0, 0, -s, (w / 2 - this.cx * this.scale) * dpr, (h / 2 + this.cy * this.scale) * dpr);
    ctx.lineWidth = 1 / this.scale;
    ctx.lineJoin = ctx.lineCap = "round";
    for (const layer of this.layers) {
      ctx.strokeStyle = layer.color;
      ctx.stroke(layer.path);
    }

    // everything else in screen pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.scale > 1.5) {
      for (const [x, y, li] of this.points) {
        if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
        const [px, py] = this.toScreen(x, y);
        ctx.fillStyle = this.pointColors[li] || "#555";
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      }
    }
    ctx.textBaseline = "alphabetic";
    for (const [x, y, ht, rot, text, li] of this.texts) {
      const px = ht * this.scale;
      if (px < MIN_TEXT_PX || x < vx0 - 50 || x > vx1 + 50 || y < vy0 - 50 || y > vy1 + 50) continue;
      const [sx, sy] = this.toScreen(x, y);
      ctx.save();
      ctx.translate(sx, sy);
      if (rot) ctx.rotate((-rot * Math.PI) / 180);
      ctx.font = `${Math.min(px, 60)}px system-ui, sans-serif`;
      ctx.fillStyle = this.pointColors[li] || "#444";
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }

    // trees, then their numbers; a number that would overlap one already drawn is left out until zoomed in
    const r = Math.max(6, Math.min(14, 0.9 * this.scale));
    const visible = [];
    for (const t of this.trees) {
      const [sx, sy] = this.toScreen(t.x, t.y);
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) continue;
      const isSel = this.selected === t.key;
      visible.push({ t, sx, sy, isSel });
      ctx.beginPath();
      ctx.arc(sx, sy, isSel ? r + 4 : r, 0, Math.PI * 2);
      ctx.fillStyle = STATUS_COLORS[t.status] || STATUS_COLORS.todo;
      ctx.fill();
      ctx.lineWidth = isSel ? 3 : 1.5;
      ctx.strokeStyle = isSel ? "#0b3d91" : "#fff";
      if (t.isNew) ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const placed = [];
    visible.sort((a, b) => b.isSel - a.isSel);
    for (const { t, sx, sy, isSel } of visible) {
      const lx = sx + r + 5, tw = ctx.measureText(t.label).width;
      const box = [lx - 2, sy - 9, lx + tw + 2, sy + 9];
      if (!isSel && placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
      placed.push(box);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(box[0], box[1], box[2] - box[0], 18);
      ctx.fillStyle = isSel ? "#0b3d91" : "#1b1f1d";
      ctx.fillText(t.label, lx, sy);
    }

    // my position
    if (this.location) {
      const [sx, sy] = this.toScreen(this.location.x, this.location.y);
      const acc = this.location.acc * this.scale;
      if (acc > 8) {
        ctx.beginPath();
        ctx.arc(sx, sy, acc, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(25,113,194,0.12)";
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#1971c2";
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }

    // scale bar
    this.drawScaleBar(w, h);
  }

  drawScaleBar(w, h) {
    const { ctx } = this;
    const target = 100 / this.scale;
    const pow = 10 ** Math.floor(Math.log10(target));
    const len = [1, 2, 5, 10].map((m) => m * pow).filter((v) => v <= target).pop() || pow;
    const px = len * this.scale;
    const x = 14, y = 16;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(x - 6, y - 10, px + 60, 22);
    ctx.strokeStyle = "#1b1f1d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.lineTo(x + px, y + 4); ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = "#1b1f1d";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(`${len >= 1 ? len : len.toFixed(1)} m`, x + px + 6, y + 1);
  }

  treeAt(sx, sy) {
    let best = null, bestD = TAP_RADIUS;
    for (const t of this.trees) {
      const [tx, ty] = this.toScreen(t.x, t.y);
      const d = Math.hypot(tx - sx, ty - sy);
      if (d < bestD) { best = t; bestD = d; }
    }
    return best;
  }

  bindEvents() {
    const c = this.canvas;
    let start = null, pinch = null, moved = false;
    const pos = (e) => {
      const rect = c.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, pos(e));
      if (this.pointers.size === 1) {
        start = { p: pos(e), cx: this.cx, cy: this.cy };
        moved = false;
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), scale: this.scale, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        pinch.world = this.toWorld(...pinch.mid);
        moved = true;
      }
    });
    c.addEventListener("pointermove", (e) => {
      const p = pos(e);
      this.onMove(this.toWorld(...p));
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2 && pinch) {
        this.startGesture();
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        this.scale = Math.min(Math.max(pinch.scale * (d / pinch.d), 0.02), 400);
        const { clientWidth: w, clientHeight: h } = c;
        this.cx = pinch.world[0] - (mid[0] - w / 2) / this.scale;
        this.cy = pinch.world[1] + (mid[1] - h / 2) / this.scale;
        this.draw();
      } else if (this.pointers.size === 1 && start) {
        const dx = p[0] - start.p[0], dy = p[1] - start.p[1];
        if (Math.hypot(dx, dy) > 6) moved = true;
        if (moved) {
          this.startGesture();
          this.cx = start.cx - dx / this.scale;
          this.cy = start.cy + dy / this.scale;
          this.draw();
        }
      }
    });
    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) {
        if (!moved && e.type === "pointerup") {
          const tree = this.treeAt(...p);
          this.onTap({ tree, world: this.toWorld(...p) });
        }
        start = null;
        pinch = null;
        if (this.snap) this.endGesture();
      } else if (this.pointers.size === 1) {
        const [q] = [...this.pointers.values()];
        start = { p: q, cx: this.cx, cy: this.cy };
        pinch = null;
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.startGesture();
      clearTimeout(this.wheelTimer);
      this.wheelTimer = setTimeout(() => this.endGesture(), 200);
      const [sx, sy] = pos(e);
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), sx, sy);
    }, { passive: false });
  }
}
