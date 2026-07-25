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
  plate: { font: '700 30px "Atkinson Hyperlegible", system-ui, sans-serif', text: '#f1f3f8', fill: 'rgba(10,12,18,.9)', border: 'rgba(255,255,255,.14)' },
  selected: { font: '700 30px "Atkinson Hyperlegible", system-ui, sans-serif', text: '#1a1405', fill: 'rgba(255,236,140,.96)', border: 'rgba(255,255,255,.5)' },
  // Folder blades at street corners, in street-sign green.
  street: { font: '700 30px "Atkinson Hyperlegible", system-ui, sans-serif', text: '#f4fff9', fill: 'rgba(14,112,76,.96)', border: 'rgba(255,255,255,.55)' },
  // Hazard tape: square-cut, edge to edge, with warning stripes where the repeated label joins.
  tapeDependabot: { font: '400 28px "Archivo Black", Impact, sans-serif', text: '#141414', fill: '#f5c518', stripe: '#141414', tape: true },
  tapeCodeScanning: { font: '400 28px "Archivo Black", Impact, sans-serif', text: '#ffffff', fill: '#d7263d', stripe: '#ffffff', tape: true },
  // District and street names painted on the ground.
  ground: { font: '400 34px "Archivo Black", Impact, sans-serif', text: 'rgba(205,198,255,.9)' },
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
    const stripes = s.tape ? 44 : 0, pad = s.tape ? 12 : s.fill ? 14 : 4, width = Math.ceil(Math.min(ctx.measureText(text).width + pad * 2 + stripes, 900));
    const slot = this.packer.add(width);
    if (!slot) return null;
    ctx.save();
    ctx.beginPath(); ctx.rect(slot.x, slot.y, slot.w, slot.h); ctx.clip();
    if (s.tape) {
      ctx.fillStyle = s.fill; ctx.fillRect(slot.x, slot.y + 4, slot.w, h - 8);
      ctx.fillStyle = s.stripe;
      for (let i = 0; i < 3; i++) { const x = slot.x + slot.w - stripes + 4 + i * 14; ctx.beginPath(); ctx.moveTo(x, slot.y + h - 4); ctx.lineTo(x + 7, slot.y + h - 4); ctx.lineTo(x + 19, slot.y + 4); ctx.lineTo(x + 12, slot.y + 4); ctx.closePath(); ctx.fill(); }
    } else if (s.fill) {
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

// Posters for the city wall, painted into one atlas. Each design is { title, body, theme }.
const POSTER_THEMES = [
  { paper: '#f2e6c9', ink: '#1d1d1f', accent: '#d7263d' },
  { paper: '#1b2a4a', ink: '#f5efe0', accent: '#f5c518' },
  { paper: '#d7263d', ink: '#fff6e8', accent: '#141414' },
  { paper: '#3ddc97', ink: '#0b1f17', accent: '#0b1f17' },
  { paper: '#8d7dff', ink: '#ffffff', accent: '#36d3c2' },
  { paper: '#f5c518', ink: '#141414', accent: '#141414' },
];

export class PosterAtlas {
  constructor(designs, width = 256, height = 376, columns = 8) {
    const rows = Math.ceil(designs.length / columns);
    this.canvas = document.createElement('canvas');
    this.canvas.width = width * columns; this.canvas.height = height * rows;
    const ctx = this.canvas.getContext('2d');
    this.uvs = designs.map((design, i) => {
      const x = (i % columns) * width, y = Math.floor(i / columns) * height;
      ctx.save(); ctx.translate(x, y); paintPoster(ctx, design, width, height, POSTER_THEMES[i % POSTER_THEMES.length], i); ctx.restore();
      return { u: x / this.canvas.width, v: y / this.canvas.height, du: width / this.canvas.width, dv: height / this.canvas.height };
    });
  }
}


// Largest font size (down to `min`) at which `text` wraps into at most `maxLines` lines that each
// fit `width`, with the block no taller than `height`. Returns { size, lines }.
export function fitText(measure, text, width, height, max, min, maxLines, lineHeight = 1.08) {
  for (let size = max; size >= min; size -= 1) {
    const lines = [], words = text.split(/\s+/).filter(Boolean);
    let line = '', fits = true;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next, size) <= width) { line = next; continue; }
      if (!line || measure(word, size) > width) { fits = false; break; } // a single word too wide
      lines.push(line); line = word;
    }
    if (line) lines.push(line);
    if (fits && lines.length <= maxLines && lines.length * size * lineHeight <= height) return { size, lines };
  }
  // Nothing fits at the smallest size: shorten only the words that are too wide on their own, then
  // keep the lines that fit, ending with an ellipsis if some had to go.
  const truncate = word => {
    if (measure(word, min) <= width) return word;
    while (word.length > 1 && measure(`${word}…`, min) > width) word = word.slice(0, -1);
    return `${word}…`;
  };
  const shortened = text.split(/\s+/).filter(Boolean).map(truncate).join(' ');
  if (shortened !== text) return fitText(measure, shortened, width, height, min, min, maxLines, lineHeight);
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, min) <= width) line = next; else { lines.push(line); line = word; }
  }
  lines.push(line);
  const room = Math.max(1, Math.min(maxLines, Math.floor(height / (min * lineHeight))));
  if (lines.length > room) {
    lines.length = room;
    let last = lines[room - 1];
    while (last.length > 1 && measure(`${last}…`, min) > width) last = last.slice(0, -1);
    lines[room - 1] = `${last}…`;
  }
  return { size: min, lines };
}

function paintPoster(ctx, { title, body }, w, h, theme, variant) {
  const inset = 6, pw = w - inset * 2, ph = h - inset * 2, pad = 16;
  ctx.save();
  // Everything below is clipped to the paper so no graphic or glyph can escape the poster.
  ctx.beginPath(); ctx.rect(inset, inset, pw, ph); ctx.clip();
  ctx.fillStyle = theme.paper; ctx.fillRect(inset, inset, pw, ph);
  // Weathering: faint speckles and a darker fold line.
  ctx.fillStyle = 'rgba(0,0,0,.06)';
  for (let i = 0; i < 70; i++) ctx.fillRect(inset + ((i * 73 + variant * 31) % pw), inset + ((i * 137 + variant * 17) % ph), 2, 2);
  ctx.fillRect(inset, h * .52, pw, 1.5);
  // A bold graphic per variant, within the top band.
  ctx.fillStyle = theme.accent;
  const shape = variant % 4;
  if (shape === 0) { ctx.beginPath(); ctx.arc(w / 2, 100, 50, 0, Math.PI * 2); ctx.fill(); }
  else if (shape === 1) { for (let i = 0; i < 8; i++) { const x = inset + i * 44; ctx.beginPath(); ctx.moveTo(x, inset); ctx.lineTo(x + 22, inset); ctx.lineTo(x - 30, 150); ctx.lineTo(x - 52, 150); ctx.fill(); } }
  else if (shape === 2) { ctx.beginPath(); ctx.moveTo(w / 2, 40); ctx.lineTo(w / 2 + 64, 160); ctx.lineTo(w / 2 - 64, 160); ctx.closePath(); ctx.fill(); ctx.fillStyle = theme.paper; ctx.font = '400 64px "Archivo Black", Impact, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText('!', w / 2, 150); }
  else { for (const y of [40, 84, 128]) ctx.fillRect(inset, y, pw, 22); }
  const font = (weight, size) => weight >= 900 ? `400 ${size}px "Archivo Black", Impact, sans-serif` : `${weight >= 600 ? 700 : 400} ${size}px "Atkinson Hyperlegible", system-ui, sans-serif`;
  const measure = weight => (text, size) => { ctx.font = font(weight, size); return ctx.measureText(text).width; };
  const footer = 30, textTop = 176, textWidth = pw - pad * 2, textBottom = h - inset - footer;
  const titleFit = fitText(measure(900), title.toUpperCase(), textWidth, (textBottom - textTop) * .55, 34, 14, 3);
  const bodyFit = fitText(measure(600), body, textWidth, textBottom - textTop - titleFit.lines.length * titleFit.size * 1.08 - 10, 17, 10, 4, 1.25);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = theme.ink;
  let y = textTop;
  ctx.font = font(900, titleFit.size);
  for (const line of titleFit.lines) { ctx.fillText(line, w / 2, y); y += titleFit.size * 1.08; }
  y += 10;
  ctx.font = font(600, bodyFit.size);
  for (const line of bodyFit.lines) { ctx.fillText(line, w / 2, y); y += bodyFit.size * 1.25; }
  ctx.font = font(700, 10); ctx.globalAlpha = .7; ctx.textBaseline = 'alphabetic';
  ctx.fillText('CODENAVIGATOR CIVIC AUTHORITY', w / 2, h - inset - 12, textWidth);
  ctx.restore();
}
