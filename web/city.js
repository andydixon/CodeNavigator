// Code as a city: folders become districts and blocks separated by roads, files become buildings.
// Everything here is plain data and maths in metres, so it can be tested without a browser.

// Squarified treemap: calls output(entry, x, y, w, h, depth) for each entry, largest first.
export function squarifiedLayout(entries, x, y, w, h, depth, output) {
  if (!entries.length || w <= 0 || h <= 0) return;
  const total = entries.reduce((sum, entry) => sum + Math.max(.0001, entry.weight), 0), scale = w * h / total;
  const remaining = entries.map(entry => ({ entry, area: Math.max(.0001, entry.weight) * scale }));
  const worst = (row, side) => {
    if (!row.length) return Infinity;
    let sum = 0, largest = 0, smallest = Infinity;
    for (const item of row) { sum += item.area; largest = Math.max(largest, item.area); smallest = Math.min(smallest, item.area); }
    return Math.max(side * side * largest / (sum * sum), (sum * sum) / (side * side * smallest));
  };
  const place = row => {
    const area = row.reduce((value, item) => value + item.area, 0);
    if (w >= h) {
      const rowWidth = Math.min(w, area / Math.max(.0001, h)); let rowY = y;
      for (const item of row) { const itemHeight = item.area / Math.max(.0001, rowWidth); output(item.entry, x, rowY, rowWidth, itemHeight, depth); rowY += itemHeight; }
      x += rowWidth; w = Math.max(0, w - rowWidth);
    } else {
      const rowHeight = Math.min(h, area / Math.max(.0001, w)); let rowX = x;
      for (const item of row) { const itemWidth = item.area / Math.max(.0001, rowHeight); output(item.entry, rowX, y, itemWidth, rowHeight, depth); rowX += itemWidth; }
      y += rowHeight; h = Math.max(0, h - rowHeight);
    }
  };
  let row = [];
  while (remaining.length) {
    const next = remaining[0], side = Math.max(.0001, Math.min(w, h));
    if (!row.length || worst([...row, next], side) <= worst(row, side)) row.push(remaining.shift());
    else { place(row); row = []; }
  }
  if (row.length) place(row);
}

export const CITY = {
  squareMetresPerLine: 1.1, // building footprint per source line
  minLines: 40, // small files still get a walkable kiosk
  roadWidths: [18, 12, 8, 6], // avenues between districts, then narrower streets per folder depth
  sidewalk: 2.5, // kerb inside each block before buildings start
  setback: 1.2, // gap between neighbouring buildings
  cellSize: 32, // spatial grid cell for collision and picking
};

// Storeys scale with complexity: a flat data file is a low warehouse, dense logic is a tower.
export function buildingHeight(file) {
  return 6 + 10 * Math.log2(1 + Math.max(0, file.complexity || 0));
}

function buildTree(files, name) {
  const root = { name, path: '', children: new Map(), files: [], weight: 0 };
  for (const file of files) {
    const parts = file.path.split('/'); parts.pop(); let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, children: new Map(), files: [], weight: 0 });
      node = node.children.get(part);
    }
    node.files.push(file);
  }
  const weigh = node => {
    node.weight = node.files.reduce((sum, file) => sum + Math.max(CITY.minLines, file.lines || 0), 0);
    for (const child of node.children.values()) node.weight += weigh(child);
    return node.weight;
  };
  weigh(root);
  return root;
}

// Returns { width, height, buildings: Map(fileId -> {x,y,w,h,height}), blocks: [{node,depth,x,y,w,h}] }.
export function layoutCity(files, name = '') {
  const root = buildTree(files, name);
  const area = root.weight * CITY.squareMetresPerLine * 1.9; // roads, sidewalks and setbacks
  const width = Math.sqrt(area * 1000 / 680), height = area / width;
  const buildings = new Map(), blocks = [];
  const visit = (node, x, y, w, h, depth) => {
    if (depth > 0) {
      // Half a road on every side, so neighbouring blocks are a full road apart.
      const half = Math.min(CITY.roadWidths[Math.min(depth - 1, CITY.roadWidths.length - 1)] / 2, w * .2, h * .2);
      x += half; y += half; w -= half * 2; h -= half * 2;
    }
    blocks.push({ node, depth, x, y, w, h });
    const kerb = Math.min(CITY.sidewalk, w * .15, h * .15);
    const values = [...node.children.values(), ...node.files.map(file => ({ file, weight: Math.max(CITY.minLines, file.lines || 0) }))];
    const total = values.reduce((sum, value) => sum + value.weight, 0), floor = total / Math.max(1, values.length * 8);
    const entries = values.map(value => ({ value, weight: Math.max(value.weight, floor) })).sort((a, b) => b.weight - a.weight);
    squarifiedLayout(entries, x + kerb, y + kerb, w - kerb * 2, h - kerb * 2, depth, (entry, rx, ry, rw, rh) => {
      const value = entry.value;
      if (!value.file) return visit(value, rx, ry, rw, rh, depth + 1);
      const gap = Math.min(CITY.setback / 2, rw * .12, rh * .12);
      buildings.set(value.file.id, { x: rx + gap, y: ry + gap, w: rw - gap * 2, h: rh - gap * 2, height: buildingHeight(value.file) });
    });
  };
  visit(root, 0, 0, width, height, 0);
  return { width, height, buildings, blocks };
}

// Uniform grid over building footprints, for collision and picking near a point or along a ray.
export function spatialIndex(entries, cellSize = CITY.cellSize) {
  const cells = new Map();
  for (const entry of entries) {
    const x0 = Math.floor(entry.x / cellSize), x1 = Math.floor((entry.x + entry.w) / cellSize);
    const y0 = Math.floor(entry.y / cellSize), y1 = Math.floor((entry.y + entry.h) / cellSize);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const key = cx * 65536 + cy, cell = cells.get(key);
      if (cell) cell.push(entry); else cells.set(key, [entry]);
    }
  }
  return {
    cellSize,
    near(x, y, radius) {
      const found = new Set();
      for (let cy = Math.floor((y - radius) / cellSize); cy <= Math.floor((y + radius) / cellSize); cy++)
        for (let cx = Math.floor((x - radius) / cellSize); cx <= Math.floor((x + radius) / cellSize); cx++)
          for (const entry of cells.get(cx * 65536 + cy) || []) found.add(entry);
      return found;
    },
  };
}

// Distance along the ray to an axis-aligned box from z=0 to z=height, or Infinity.
export function rayBox([ox, oy, oz], [dx, dy, dz], box) {
  let near = 0, far = Infinity;
  for (const [o, d, min, max] of [[ox, dx, box.x, box.x + box.w], [oy, dy, box.y, box.y + box.h], [oz, dz, 0, box.height]]) {
    if (Math.abs(d) < 1e-9) { if (o < min || o > max) return Infinity; continue; }
    let t0 = (min - o) / d, t1 = (max - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0); far = Math.min(far, t1);
    if (near > far) return Infinity;
  }
  return near;
}

// Nearest building hit by a ray: { entry, distance } or null.
// ponytail: tests every building; walk the spatial grid along the ray if repos pass ~100k files.
export function pickRay(origin, dir, entries, maxDistance = Infinity) {
  let best = null, distance = maxDistance;
  for (const entry of entries) {
    const t = rayBox(origin, dir, entry);
    if (t < distance) { distance = t; best = entry; }
  }
  return best && { entry: best, distance };
}
