// Text for the 3D city: labels are rasterised once into a shared atlas and drawn as textured quads,
// so signs are depth-tested against buildings instead of floating over them like DOM or 2D overlays.

// Rows of fixed height filled left to right. add() returns a slot or null when the atlas is full.
export class ShelfPacker {
  constructor(width, height, rowHeight) { Object.assign(this, { width, height, rowHeight }); this.reset(); }
  reset() { this.x = 0; this.y = 0; }
  add(width) {
    width = Math.min(width, this.width);
    if (this.x + width > this.width) { this.x = 0; this.y += this.rowHeight; }
    if (this.y + this.rowHeight > this.height) return null;
    const slot = { x: this.x, y: this.y, w: width, h: this.rowHeight };
    this.x += width + 2;
    return slot;
  }
}

const STYLES = {
  // Name plates on roofs and walls.
  plate: { font: '600 30px Inter, system-ui, sans-serif', text: '#f1f3f8', fill: 'rgba(10,12,18,.9)', border: 'rgba(255,255,255,.14)' },
  selected: { font: '700 30px Inter, system-ui, sans-serif', text: '#1a1405', fill: 'rgba(255,236,140,.96)', border: 'rgba(255,255,255,.5)' },
  // District and street names painted on the ground.
  ground: { font: '700 34px Inter, system-ui, sans-serif', text: 'rgba(205,198,255,.9)' },
};

export class LabelAtlas {
  constructor(width = 2048, height = 4096, rowHeight = 48) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.packer = new ShelfPacker(width, height, rowHeight);
    this.entries = new Map();
    this.generation = 0; // bumps when the atlas is cleared and every entry is invalid
    this.dirty = null;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.entries.clear(); this.packer.reset(); this.generation++;
    this.dirty = { x0: 0, y0: 0, x1: this.canvas.width, y1: this.canvas.height };
  }

  // Atlas rectangle for text in a style: { u, v, du, dv, aspect }, or null if it cannot fit.
  get(text, style = 'plate') {
    const key = `${style}\n${text}`;
    const cached = this.entries.get(key);
    if (cached) return cached;
    const s = STYLES[style], ctx = this.ctx, h = this.packer.rowHeight;
    ctx.font = s.font;
    const pad = s.fill ? 14 : 4, width = Math.ceil(Math.min(ctx.measureText(text).width + pad * 2, 900));
    const slot = this.packer.add(width);
    if (!slot) return null;
    ctx.save();
    ctx.beginPath(); ctx.rect(slot.x, slot.y, slot.w, slot.h); ctx.clip();
    if (s.fill) {
      ctx.fillStyle = s.fill; ctx.strokeStyle = s.border; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(slot.x + 1, slot.y + 3, slot.w - 2, h - 6, 12); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = s.text; ctx.textBaseline = 'middle';
    ctx.fillText(text, slot.x + pad, slot.y + h / 2 + 1, slot.w - pad * 2);
    ctx.restore();
    const W = this.canvas.width, H = this.canvas.height;
    const entry = { u: slot.x / W, v: slot.y / H, du: slot.w / W, dv: slot.h / H, aspect: slot.w / slot.h };
    this.entries.set(key, entry);
    const d = this.dirty ||= { x0: slot.x, y0: slot.y, x1: slot.x, y1: slot.y };
    d.x0 = Math.min(d.x0, slot.x); d.y0 = Math.min(d.y0, slot.y); d.x1 = Math.max(d.x1, slot.x + slot.w); d.y1 = Math.max(d.y1, slot.y + slot.h);
    return entry;
  }

  // Pixels changed since the last call, as { x, y, image }, or null.
  takeDirty() {
    const d = this.dirty; if (!d) return null;
    this.dirty = null;
    const w = Math.max(1, d.x1 - d.x0), h = Math.max(1, d.y1 - d.y0);
    return { x: d.x0, y: d.y0, image: this.ctx.getImageData(d.x0, d.y0, w, h) };
  }
}
