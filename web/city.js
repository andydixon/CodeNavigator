// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Andy Dixon
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
  setback: 2.4, // alley between neighbouring buildings, wide enough for a path to a back door
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
    let half = 0;
    if (depth > 0) {
      // Half a road on every side, so neighbouring blocks are a full road apart.
      half = Math.min(CITY.roadWidths[Math.min(depth - 1, CITY.roadWidths.length - 1)] / 2, w * .2, h * .2);
      x += half; y += half; w -= half * 2; h -= half * 2;
    }
    blocks.push({ node, depth, x, y, w, h, road: half });
    const kerb = Math.min(CITY.sidewalk, w * .15, h * .15);
    const values = [...node.children.values(), ...node.files.map(file => ({ file, weight: Math.max(CITY.minLines, file.lines || 0) }))];
    const total = values.reduce((sum, value) => sum + value.weight, 0), floor = total / Math.max(1, values.length * 8);
    const entries = values.map(value => ({ value, weight: Math.max(value.weight, floor) })).sort((a, b) => b.weight - a.weight);
    squarifiedLayout(entries, x + kerb, y + kerb, w - kerb * 2, h - kerb * 2, depth, (entry, rx, ry, rw, rh) => {
      const value = entry.value;
      if (!value.file) return visit(value, rx, ry, rw, rh, depth + 1);
      const gap = Math.min(CITY.setback / 2, rw * .22, rh * .22);
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

// Pushes a circle of `radius` at (x, y) out of every building it overlaps.
export function collide(x, y, radius, index) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const b of index.near(x, y, radius + 1)) {
      const nx = Math.max(b.x, Math.min(x, b.x + b.w)), ny = Math.max(b.y, Math.min(y, b.y + b.h));
      let dx = x - nx, dy = y - ny;
      const distance = Math.hypot(dx, dy);
      if (distance >= radius) continue;
      if (distance === 0) {
        // Centre inside the footprint: leave through the nearest wall.
        const exits = [[b.x - radius - x, 0], [b.x + b.w + radius - x, 0], [0, b.y - radius - y], [0, b.y + b.h + radius - y]];
        [dx, dy] = exits.reduce((best, exit) => Math.hypot(...exit) < Math.hypot(...best) ? exit : best);
        x += dx; y += dy;
      } else {
        x = nx + dx / distance * radius; y = ny + dy / distance * radius;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return { x, y };
}

// Horizontal forward and right vectors for a heading; yaw 0 faces -y (north on the map).
export function heading(yaw) {
  return { forward: [-Math.sin(yaw), -Math.cos(yaw)], right: [Math.cos(yaw), -Math.sin(yaw)] };
}

export const MOVE = { walk: 7, run: 18, fly: 40, flyFast: 160, radius: .45, eyeHeight: 1.7 };

// Advances a walk/fly camera by dt seconds. input: {forward, right, up} in -1..1 and run (bool).
export function stepCamera(camera, input, dt, index, bounds) {
  // Sub-steps keep a long frame from carrying the walker through a thin building.
  for (; dt > .05; dt -= .05) stepCamera(camera, input, .05, index, bounds);
  const fly = camera.view === 'fly', speed = (fly ? (input.run ? MOVE.flyFast : MOVE.fly) : (input.run ? MOVE.run : MOVE.walk)) * dt;
  const { forward, right } = heading(camera.lookYaw);
  let mx = forward[0] * input.forward + right[0] * input.right, my = forward[1] * input.forward + right[1] * input.right;
  const length = Math.hypot(mx, my);
  if (length > 1) { mx /= length; my /= length; }
  let x = camera.ex + mx * speed, y = camera.ey + my * speed;
  if (fly) {
    // Flying follows the view pitch, so looking down and pressing forward descends.
    const vertical = Math.sin(camera.lookPitch) * input.forward + input.up;
    camera.ez = Math.max(MOVE.eyeHeight, Math.min(3000, camera.ez + vertical * speed));
  } else {
    camera.ez = MOVE.eyeHeight;
  }
  if (camera.ez < 400) ({ x, y } = collide(x, y, MOVE.radius, { near: (px, py, r) => [...index.near(px, py, r)].filter(b => b.height + .5 > camera.ez - MOVE.eyeHeight) }));
  // Never beyond the city wall, even when flying over it.
  const edge = bounds.edge ?? 150;
  camera.ex = Math.max(-edge, Math.min(bounds.width + edge, x));
  camera.ey = Math.max(-edge, Math.min(bounds.height + edge, y));
  return camera;
}

// Deepest folder block containing a point, for the "you are here" address.
export function blockAt(blocks, x, y) {
  let best = null;
  for (const block of blocks) if (block.depth > 0 && x >= block.x && x <= block.x + block.w && y >= block.y && y <= block.y + block.h && (!best || block.depth > best.depth)) best = block;
  return best;
}

// Where a ray meets the ground plane (z = 0), or null if it points up.
export function groundHit([ox, oy, oz], [dx, dy, dz]) {
  if (dz >= -1e-6) return null;
  const t = -oz / dz;
  return [ox + dx * t, oy + dy * t];
}

// ---- Sign placement. A quad is { c: centre, u: half-width axis, v: half-height axis } in metres. ----

// Text lying flat, reading left to right along +x with its top toward north (-y).
export function flatQuad(cx, cy, z, width, height) {
  return { c: [cx, cy, z], u: [width / 2, 0, 0], v: [0, -height / 2, 0] };
}

// The four walls of a footprint: centre on the ground, outward normal, width.
function walls(b) {
  return [
    { c: [b.x + b.w / 2, b.y + b.h], n: [0, 1], width: b.w },
    { c: [b.x + b.w / 2, b.y], n: [0, -1], width: b.w },
    { c: [b.x + b.w, b.y + b.h / 2], n: [1, 0], width: b.h },
    { c: [b.x, b.y + b.h / 2], n: [-1, 0], width: b.h },
  ];
}

// Vertical quad just outside a wall, reading left to right for someone facing that wall.
function wallQuad(wall, z, width, height) {
  const offset = .06, right = [wall.n[1], -wall.n[0]];
  return { c: [wall.c[0] + wall.n[0] * offset, wall.c[1] + wall.n[1] * offset, z], u: [right[0] * width / 2, right[1] * width / 2, 0], v: [0, 0, height / 2] };
}

// Name signs on the walls that face the viewer, a clear metre and more above the top of the door.
export function wallSigns(b, eye, aspect, height = .9, z = DOOR.height + 1.6) {
  const out = [];
  for (const wall of walls(b)) {
    if ((eye[0] - wall.c[0]) * wall.n[0] + (eye[1] - wall.c[1]) * wall.n[1] <= 0) continue;
    // Long walls repeat the sign every ~24 m so one is always near someone walking past.
    const count = Math.max(1, Math.floor(wall.width / 24)), segment = wall.width / count, along = [wall.n[1], -wall.n[0]];
    const width = Math.min(segment * .85, aspect * height);
    for (let i = 0; i < count; i++) {
      const offset = (i + .5) * segment - wall.width / 2;
      out.push(wallQuad({ ...wall, c: [wall.c[0] + along[0] * offset, wall.c[1] + along[1] * offset] }, Math.min(z, b.height - height), width, width / aspect));
    }
  }
  return out;
}

// The wall most squarely facing the viewer, covered with the file's source at the texture's aspect.
export function facadeQuad(b, eye, aspect) {
  let best = null, score = 0;
  for (const wall of walls(b)) {
    const dx = eye[0] - wall.c[0], dy = eye[1] - wall.c[1], facing = (dx * wall.n[0] + dy * wall.n[1]) / (Math.hypot(dx, dy) || 1);
    if (facing > score) { score = facing; best = wall; }
  }
  if (!best) return null;
  let width = best.width * .9, height = width / aspect;
  const room = Math.max(1, (b.height - 1.5) * .92);
  if (height > room) { height = room; width = height * aspect; }
  return wallQuad(best, 1.2 + height / 2, width, height);
}

// ---- Guided tour, shareable places and touch input ----

// Largest districts first, each with a helicopter pose that frames it.
export function tourStops(districts, limit = 6) {
  return [...districts].sort((a, b) => b.lines - a.lines).slice(0, limit).map((district, index) => {
    const b = district.block;
    return { district, pose: { x: b.x + b.w / 2, y: b.y + b.h / 2, distance: Math.max(120, Math.max(b.w, b.h) * 1.35), pitch: .5, yaw: -.6 + index * 1.1 } };
  });
}

const CAMERA_FIELDS = { heli: ['x', 'y', 'yaw', 'pitch', 'distance'], walk: ['ex', 'ey', 'ez', 'lookYaw', 'lookPitch'], fly: ['ex', 'ey', 'ez', 'lookYaw', 'lookPitch'] };
const GITHUB_REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

// A place in a codebase as a URL fragment: repository, view, city camera and selected file.
export function encodePlace({ repo, view, camera, file }) {
  const params = new URLSearchParams({ repo, view });
  if (view === 'city' && camera && CAMERA_FIELDS[camera.view]) {
    params.set('cam', `${camera.view}:${CAMERA_FIELDS[camera.view].map(key => +camera[key].toFixed(key.startsWith('e') || key === 'x' || key === 'y' || key === 'distance' ? 1 : 3)).join(',')}`);
  }
  if (file) params.set('file', file);
  return `#${params}`;
}

export function decodePlace(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const repo = params.get('repo');
  if (!repo || !GITHUB_REPO.test(repo)) return null;
  const view = ['2d', '3d', 'city'].includes(params.get('view')) ? params.get('view') : '2d';
  const place = { repo, view, file: params.get('file') || null, camera: null };
  const [camView, values] = (params.get('cam') || '').split(':');
  const numbers = (values || '').split(',').map(Number);
  if (CAMERA_FIELDS[camView] && numbers.length === CAMERA_FIELDS[camView].length && numbers.every(Number.isFinite)) {
    place.camera = { view: camView, ...Object.fromEntries(CAMERA_FIELDS[camView].map((key, i) => [key, numbers[i]])) };
  }
  return place;
}

// Virtual joystick: drag offset in pixels to forward/right in -1..1, with a small dead zone.
export function joystick(dx, dy, radius = 56) {
  const length = Math.hypot(dx, dy);
  if (length < radius * .12) return { forward: 0, right: 0 };
  const scale = Math.min(1, length / radius) / length;
  return { forward: -dy * scale, right: dx * scale };
}

// A quad's text reads correctly only from the side where (u x v) points away from the viewer
// (the world is left-handed). The sign shader applies the same test to skip mirrored faces.
export function readableFrom(quad, eye) {
  const [ux, uy, uz] = quad.u, [vx, vy, vz] = quad.v;
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  return n[0] * (eye[0] - quad.c[0]) + n[1] * (eye[1] - quad.c[1]) + n[2] * (eye[2] - quad.c[2]) < 0;
}

// One blade: two back-to-back faces sticking out of a wall at `offset` metres along it from its centre.
// clearance(x, y, direction) is the free distance outward; blades shorten to it or are skipped.
function blade(wall, offset, aspect, clearance, z, height = .7, maxWidth = 5.5) {
  const inset = .15, along = [wall.n[1], -wall.n[0]];
  const x = wall.c[0] + along[0] * offset, y = wall.c[1] + along[1] * offset;
  const room = clearance ? clearance(x, y, wall.n) - inset - .5 : Infinity;
  const width = Math.min(maxWidth, aspect * height, room);
  if (width < 1.2) return [];
  const c = [x + wall.n[0] * (inset + width / 2), y + wall.n[1] * (inset + width / 2), z];
  const u = [wall.n[0] * width / 2, wall.n[1] * width / 2, 0], v = [0, 0, width / aspect / 2];
  return [{ c, u, v }, { c, u: u.map(value => -value), v }];
}

// Street-corner signs naming a folder. For each corner of the folder's block, the building nearest
// that corner gets a blade on each of its two walls facing the corner's streets, near the corner end,
// so an intersection shows every neighbouring folder on its own side. Walls set back further than
// `edge` metres from the block boundary face an inner courtyard, not a street, and are skipped.
export function folderBlades(block, buildings, eye, aspect, clearance, edge = 4.5) {
  const out = [];
  if (!buildings.length) return out;
  const corners = [
    { x: block.x, y: block.y, normals: [[0, -1], [-1, 0]] },
    { x: block.x + block.w, y: block.y, normals: [[0, -1], [1, 0]] },
    { x: block.x, y: block.y + block.h, normals: [[0, 1], [-1, 0]] },
    { x: block.x + block.w, y: block.y + block.h, normals: [[0, 1], [1, 0]] },
  ];
  const seen = new Set();
  for (const corner of corners) {
    let nearest = null, best = Infinity;
    for (const b of buildings) {
      const d = Math.hypot(Math.max(b.x - corner.x, 0, corner.x - b.x - b.w), Math.max(b.y - corner.y, 0, corner.y - b.y - b.h));
      if (d < best) { best = d; nearest = b; }
    }
    for (const n of corner.normals) {
      const wall = walls(nearest).find(w => w.n[0] === n[0] && w.n[1] === n[1]);
      const key = `${buildings.indexOf(nearest)}:${n}:${corner.x}:${corner.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Distance from this wall to the block boundary on the same side.
      const setback = n[0] ? Math.abs((n[0] > 0 ? block.x + block.w : block.x) - wall.c[0]) : Math.abs((n[1] > 0 ? block.y + block.h : block.y) - wall.c[1]);
      if (setback > edge) continue;
      if (eye && (eye[0] - wall.c[0]) * n[0] + (eye[1] - wall.c[1]) * n[1] <= 0) continue;
      const along = [n[1], -n[0]], toCorner = Math.sign((corner.x - wall.c[0]) * along[0] + (corner.y - wall.c[1]) * along[1]) || 1;
      const offset = toCorner * Math.max(0, wall.width / 2 - Math.min(1.5, wall.width * .2));
      out.push(...blade(wall, offset, aspect, clearance, Math.max(2.6, Math.min(4.2, nearest.height - .8))));
    }
  }
  return out;
}

// Folder path for a street sign: the whole path when short, otherwise its tail after an ellipsis.
export function folderLabel(path, root, max = 34) {
  if (!path) return root;
  if (path.length <= max) return path;
  const parts = path.split('/');
  let label = parts.pop();
  while (parts.length && label.length + parts[parts.length - 1].length + 3 <= max) label = `${parts.pop()}/${label}`;
  return `…/${label}`;
}

// ---- Walkable grid, routes along streets and wandering residents ----

// Occupancy grid over the city: cells overlapping a building (grown by `margin`) are blocked, and
// cells inside a block (pavements) cost a little more than roads so routes prefer the street.
export function buildNavGrid(buildings, blocks, bounds, cell = 3, margin = .5) {
  const pad = 40, ox = -pad, oy = -pad;
  const cols = Math.ceil((bounds.width + pad * 2) / cell), rows = Math.ceil((bounds.height + pad * 2) / cell);
  const blocked = new Uint8Array(cols * rows), cost = blocks.length ? new Float32Array(cols * rows).fill(1) : null;
  const cellsOf = (x0, y0, x1, y1, fn) => {
    const c0 = Math.max(0, Math.floor((x0 - ox) / cell)), c1 = Math.min(cols - 1, Math.floor((x1 - ox) / cell));
    const r0 = Math.max(0, Math.floor((y0 - oy) / cell)), r1 = Math.min(rows - 1, Math.floor((y1 - oy) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * cols + c);
  };
  if (cost) for (const block of blocks) if (block.depth > 0) cellsOf(block.x, block.y, block.x + block.w - 1e-6, block.y + block.h - 1e-6, i => { cost[i] = 1.35; });
  for (const b of buildings) cellsOf(b.x - margin, b.y - margin, b.x + b.w + margin - 1e-6, b.y + b.h + margin - 1e-6, i => { blocked[i] = 1; });
  return { cell, cols, rows, ox, oy, blocked, cost };
}

export const cellCenter = (grid, index) => [grid.ox + (index % grid.cols + .5) * grid.cell, grid.oy + (Math.floor(index / grid.cols) + .5) * grid.cell];
const cellAt = (grid, x, y) => {
  const c = Math.floor((x - grid.ox) / grid.cell), r = Math.floor((y - grid.oy) / grid.cell);
  return c < 0 || r < 0 || c >= grid.cols || r >= grid.rows ? -1 : r * grid.cols + c;
};
export const walkable = (grid, x, y) => { const i = cellAt(grid, x, y); return i >= 0 && !grid.blocked[i]; };

// Free cells in a ring just outside a building's blocked cells: its "doors" onto the street.
function doors(grid, b) {
  const out = [], reach = grid.cell + 1;
  // Blocked cells that belong to this building (its grown footprint), not a neighbour's.
  const inside = (c, r) => {
    const x = grid.ox + (c + .5) * grid.cell, y = grid.oy + (r + .5) * grid.cell, half = grid.cell / 2 + .5;
    return x > b.x - half && x < b.x + b.w + half && y > b.y - half && y < b.y + b.h + half;
  };
  const c0 = Math.max(0, Math.floor((b.x - reach - grid.ox) / grid.cell)), c1 = Math.min(grid.cols - 1, Math.floor((b.x + b.w + reach - grid.ox) / grid.cell));
  const r0 = Math.max(0, Math.floor((b.y - reach - grid.oy) / grid.cell)), r1 = Math.min(grid.rows - 1, Math.floor((b.y + b.h + reach - grid.oy) / grid.cell));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const i = r * grid.cols + c;
    if (grid.blocked[i]) continue;
    const touches = (cc, rr) => cc >= 0 && rr >= 0 && cc < grid.cols && rr < grid.rows && grid.blocked[rr * grid.cols + cc] && inside(cc, rr);
    if (touches(c - 1, r) || touches(c + 1, r) || touches(c, r - 1) || touches(c, r + 1)) out.push(i);
  }
  return out;
}

class MinHeap {
  constructor() { this.keys = []; this.items = []; }
  get size() { return this.items.length; }
  push(item, key) {
    const k = this.keys, it = this.items; let i = it.length; k.push(key); it.push(item);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; it[i] = it[p]; i = p; }
    k[i] = key; it[i] = item;
  }
  pop() {
    const k = this.keys, it = this.items, top = it[0], key = k.pop(), item = it.pop();
    if (it.length) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= it.length) break; if (c + 1 < it.length && k[c + 1] < k[c]) c++; if (k[c] >= key) break; k[i] = k[c]; it[i] = it[c]; i = c; }
      k[i] = key; it[i] = item;
    }
    return top;
  }
}

// Straight line between two points stays on walkable cells (sampled at quarter-cell steps, so a
// shortcut can't clip a blocked cell's corner by more than a fraction of the margin).
export function clearLine(grid, a, b) {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (grid.cell * .25));
  for (let s = 1; s < steps; s++) if (!walkable(grid, a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps)) return false;
  return true;
}

// Keeps only the turns a walker needs: each point jumps as far ahead as it can see in a straight line.
export function simplifyRoute(grid, points) {
  if (points.length < 3) return points;
  // Scans forward and stops at the first obstruction, so each turn costs about its street's length.
  const out = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = i + 1;
    while (j + 1 < points.length && clearLine(grid, points[i], points[j + 1])) j++;
    out.push(points[j]); i = j;
  }
  return out;
}

// Street routes from one building to each target building: one Dijkstra pass from the source's
// doors that stops once every target door is settled. Returns an array aligned with `targets`
// holding point lists (metres), or null where a target cannot be reached.
export function routesFrom(grid, source, targets) {
  const { cols, rows, blocked, cost } = grid, n = cols * rows;
  // Float64: float32 distances round up, so equal paths look like improvements and flood the queue.
  const distance = new Float64Array(n).fill(Infinity), parent = new Int32Array(n).fill(-1), heap = new MinHeap();
  // Buildings with a door start and finish on its doorstep; others use any cell beside them.
  const entrances = b => { const step = b.door && cellAt(grid, ...b.door.step); return step >= 0 && step !== undefined && !blocked[step] ? [step] : doors(grid, b); };
  for (const door of entrances(source)) { distance[door] = 0; heap.push(door, 0); }
  const settled = new Uint8Array(n);
  const goals = targets.map(t => new Set(entrances(t)));
  const reached = targets.map(() => -1);
  let remaining = targets.length;
  const neighbours = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.size && remaining) {
    const i = heap.pop();
    if (settled[i]) continue; // a stale, longer queue entry
    settled[i] = 1;
    const d = distance[i];
    for (let t = 0; t < goals.length; t++) if (reached[t] < 0 && goals[t].has(i)) { reached[t] = i; remaining--; }
    const c = i % cols, r = (i - c) / cols;
    for (const [dc, dr, step] of neighbours) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const j = nr * cols + nc;
      // No corner cutting: a diagonal needs both orthogonal neighbours free.
      if (blocked[j] || (dc && dr && (blocked[r * cols + nc] || blocked[nr * cols + c]))) continue;
      const next = d + step * (cost ? (cost[i] + cost[j]) / 2 : 1);
      if (next < distance[j]) { distance[j] = next; parent[j] = i; heap.push(j, next); }
    }
  }
  // Buildings boxed in by their neighbours have no door on a street: end at the reachable
  // street cell nearest the building instead.
  const found = reached.map(end => end >= 0);
  for (let t = 0; t < targets.length; t++) {
    if (reached[t] >= 0) continue;
    const b = targets[t], cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!settled[i]) continue;
      const [x, y] = cellCenter(grid, i), d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < best) { best = d; reached[t] = i; }
    }
  }
  return reached.map((end, t) => {
    if (end < 0) return null;
    const cells = [];
    for (let i = end; i >= 0; i = parent[i]) cells.push(cellCenter(grid, i));
    const route = simplifyRoute(grid, cells.reverse());
    route.reached = found[t]; // false when it stopped at the nearest street instead of the target
    return route;
  });
}

// Wandering residents: little figures that stroll between points they can see, pause, and often
// drift toward one another so they gather in small crowds.
export function spawnWanderers(grid, count, random = Math.random, bounds = null) {
  const out = [];
  for (let tries = 0; out.length < count && tries < count * 50; tries++) {
    const i = Math.floor(random() * grid.cols * grid.rows);
    if (grid.blocked[i]) continue;
    const [x, y] = cellCenter(grid, i);
    if (bounds && (x < 0 || y < 0 || x > bounds.width || y > bounds.height)) continue; // streets, not the empty margin
    out.push({ x, y, tx: x, ty: y, speed: .9 + random() * .9, phase: random() * 6.28, pause: random() * 3, seed: random() });
  }
  return out;
}

function chooseTarget(w, all, grid, random) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let tx, ty;
    const friend = random() < .35 ? all[Math.floor(random() * all.length)] : null;
    if (friend && friend !== w && Math.hypot(friend.x - w.x, friend.y - w.y) < 45) {
      tx = friend.x + (random() - .5) * 4; ty = friend.y + (random() - .5) * 4;
    } else {
      const angle = random() * Math.PI * 2, distance = 6 + random() * 34;
      tx = w.x + Math.cos(angle) * distance; ty = w.y + Math.sin(angle) * distance;
    }
    if (walkable(grid, tx, ty) && clearLine(grid, [w.x, w.y], [tx, ty])) { w.tx = tx; w.ty = ty; return; }
  }
  w.pause = .5 + random() * 1.5; // boxed in for now; look around and try again
}

export function stepWanderers(all, grid, dt, random = Math.random) {
  for (const w of all) {
    if (w.pause > 0) { w.pause -= dt; if (w.pause <= 0) chooseTarget(w, all, grid, random); continue; }
    const dx = w.tx - w.x, dy = w.ty - w.y, distance = Math.hypot(dx, dy), step = Math.min(distance, w.speed * dt);
    if (distance < .3) { w.pause = random() < .5 ? random() * 3 : 0; if (w.pause <= 0) chooseTarget(w, all, grid, random); continue; }
    const nx = w.x + dx / distance * step, ny = w.y + dy / distance * step;
    if (!walkable(grid, nx, ny)) { chooseTarget(w, all, grid, random); continue; }
    w.x = nx; w.y = ny; w.phase += step * 3.2; // stride cycles per metre
  }
}

// Deterministic generator for tests and reproducible crowds.
export function seededRandom(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ---- Security alerts: burning buildings and hazard tape ----

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

// Groups an /alerts response by file path: { codeScanning: [], dependabot: [], worst }.
export function alertsByPath(response) {
  const byPath = new Map();
  if (!response?.available) return byPath;
  for (const [kind, set] of [['codeScanning', response.codeScanning], ['dependabot', response.dependabot]]) {
    for (const alert of set?.alerts || []) {
      if (!alert.path) continue;
      const entry = byPath.get(alert.path) || { codeScanning: [], dependabot: [], worst: 'low' };
      entry[kind].push(alert);
      if ((SEVERITY_RANK[alert.severity] || 0) > SEVERITY_RANK[entry.worst]) entry.worst = alert.severity;
      byPath.set(alert.path, entry);
    }
  }
  return byPath;
}

// Critical and high alerts set a building alight; medium and low only smoulder.
export const burns = severity => (SEVERITY_RANK[severity] || 0) >= SEVERITY_RANK.high;

// Hazard tape running diagonally across every wall, as segments tiling a repeated label.
// direction 1 rises left to right (Dependabot), -1 falls (code scanning), so both together form an X.
// Each segment is a quad plus `fraction`, the share of the label it shows (the last one is cut short).
export function tapeQuads(b, aspect, direction = 1) {
  const out = [], tape = Math.max(1.8, Math.min(5, Math.min(b.w, b.h) * .14)), offset = .1 + (direction > 0 ? 0 : .02);
  for (const wall of walls(b)) {
    const width = wall.width, height = b.height, length = Math.hypot(width, height);
    if (width < 3) continue;
    const right = [wall.n[1], -wall.n[0]], dx = width / length, dz = direction * height / length, segment = tape * aspect;
    const startAlong = -width / 2, startZ = direction > 0 ? 0 : height;
    for (let s = 0; s < length; s += segment) {
      const piece = Math.min(segment, length - s), mid = s + piece / 2;
      const along = startAlong + dx * mid, z = startZ + dz * mid;
      out.push({
        c: [wall.c[0] + right[0] * along + wall.n[0] * offset, wall.c[1] + right[1] * along + wall.n[1] * offset, z],
        u: [right[0] * dx * piece / 2, right[1] * dx * piece / 2, dz * piece / 2],
        v: [-right[0] * dz * tape / 2, -right[1] * dz * tape / 2, dx * tape / 2],
        fraction: piece / segment,
      });
    }
  }
  return out;
}

// ---- The city wall and its posters ----

export const WALL = { margin: 24, height: 14, thickness: 2 };

// Four boxes enclosing the city `margin` metres beyond its edge; `inward` is the city-facing normal.
export function cityWalls(bounds, { margin, height, thickness } = WALL) {
  const x0 = -margin - thickness, y0 = -margin - thickness, x1 = bounds.width + margin, y1 = bounds.height + margin, span = x1 + thickness - x0;
  return [
    { x: x0, y: y0, w: span, h: thickness, height, inward: [0, 1] },
    { x: x0, y: y1, w: span, h: thickness, height, inward: [0, -1] },
    { x: x0, y: y0, w: thickness, h: y1 + thickness - y0, height, inward: [1, 0] },
    { x: x1, y: y0, w: thickness, h: y1 + thickness - y0, height, inward: [-1, 0] },
  ];
}

// Posters pasted on the city side of the walls at random spots, sizes and tilts (up to ±25°),
// one per ~35 m of wall. Each quad carries `poster`, an index into `designs`.
export function posterQuads(walls, designs, random = Math.random) {
  const out = [];
  for (const wall of walls) {
    const [nx, ny] = wall.inward, length = nx ? wall.h : wall.w;
    const along = [ny, -nx]; // left to right for someone facing the wall from inside
    const face = [wall.x + wall.w / 2 + nx * wall.w / 2, wall.y + wall.h / 2 + ny * wall.h / 2];
    for (let i = 0, count = Math.max(1, Math.round(length / 35)); i < count; i++) {
      const height = 3 + random() * 2.5, width = height * .68, tilt = (random() - .5) * .87;
      const offset = (random() - .5) * (length - 12), z = 2.2 + height / 2 + random() * (wall.height - height - 3.5);
      const cos = Math.cos(tilt), sin = Math.sin(tilt), lift = .05 + i * .002; // later posters sit on top
      out.push({
        c: [face[0] + along[0] * offset + nx * lift, face[1] + along[1] * offset + ny * lift, z],
        u: [along[0] * cos * width / 2, along[1] * cos * width / 2, sin * width / 2],
        v: [-along[0] * sin * height / 2, -along[1] * sin * height / 2, cos * height / 2],
        poster: Math.floor(random() * designs),
      });
    }
  }
  return out;
}

// Flat ribbon triangles for routes on the ground: per vertex x, y, z, across (-1 left .. 1 right),
// along (metres from the route's start) and kind. Ribbons keep to the right of their direction of
// travel, so an outbound and an inbound route sharing a street run in separate lanes.
export const ROUTE_KIND = { knownImport: 0, inferredImport: 1, dependent: 2 };
export function ribbonVertices(routes, width = 1.3, z = .45, lane = .8) {
  const vertices = [];
  for (const route of routes) {
    // Drop repeated points so every segment has a direction.
    const keep = route.points.map((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-3);
    const points = route.points.filter((_, i) => keep[i]), narrow = (route.narrow || []).filter((_, i) => keep[i]);
    if (points.length < 2) continue;
    // Right-of-travel normal per segment: (-dy, dx) in this left-handed world (see heading()).
    const normals = [];
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i - 1][0], dy = points[i][1] - points[i - 1][1], length = Math.hypot(dx, dy);
      normals.push([-dy / length, dx / length]);
    }
    // Mitred offsets at each vertex, so neighbouring segments share their corner edge exactly
    // instead of overlapping. Very sharp turns fall back to the outgoing normal.
    const mitre = i => {
      const a = normals[Math.max(0, i - 1)], b = normals[Math.min(normals.length - 1, i)], dot = a[0] * b[0] + a[1] * b[1];
      if (1 + dot < .25) return b;
      return [(a[0] + b[0]) / (1 + dot), (a[1] + b[1]) / (1 + dot)];
    };
    let along = 0;
    const edge = points.map((p, i) => {
      if (i) along += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]);
      // Alley points are single-file: narrower and centred instead of in a lane.
      const m = mitre(i), w = narrow[i] ? .5 : width, offset = narrow[i] ? 0 : lane;
      return { left: [p[0] + m[0] * (offset - w / 2), p[1] + m[1] * (offset - w / 2)], right: [p[0] + m[0] * (offset + w / 2), p[1] + m[1] * (offset + w / 2)], along };
    });
    for (let i = 1; i < edge.length; i++) {
      const a = edge[i - 1], b = edge[i];
      const v = (p, side, at) => vertices.push(p[0], p[1], z, side, at, route.kind);
      v(a.left, -1, a.along); v(a.right, 1, a.along); v(b.right, 1, b.along);
      v(a.left, -1, a.along); v(b.right, 1, b.along); v(b.left, -1, b.along);
    }
  }
  return vertices;
}

// Extends a route end from the street into a building: to the nearest point of its footprint, then
// `depth` metres inside, so the path visibly runs up to (and under) the wall.
export function enterBuilding(point, b, depth = .8) {
  const nx = Math.max(b.x, Math.min(point[0], b.x + b.w)), ny = Math.max(b.y, Math.min(point[1], b.y + b.h));
  const dx = nx - point[0], dy = ny - point[1], length = Math.hypot(dx, dy);
  if (length < 1e-6) return [nx, ny];
  return [nx + dx / length * depth, ny + dy / length * depth];
}

// ---- Doors ----

export const DOOR = { width: 2.8, height: 3, cornerClearance: 1.2 };

// Gives each building one door, centred on a wall where possible and never within
// DOOR.cornerClearance of a corner. Buildings on a street get their door facing it; buildings
// in the middle of a folder get a back door with a path along the alleys (on `fine`, a
// half-metre grid) out to the nearest street.
// door: { at: [x, y] on the wall, n: outward normal, width, path: [at, ..., step] out to the
// street (step is walkable on `grid`), inside: a point in the building, access: 'street' | 'alley' }.
export function assignDoors(buildings, grid, fine = null) {
  let distance = null; // built on first need
  for (const b of buildings) {
    const candidates = [];
    for (const wall of walls(b)) {
      const corner = Math.min(DOOR.cornerClearance, wall.width * .2), width = Math.min(DOOR.width, wall.width - corner * 2);
      if (width < 1) continue;
      const along = [wall.n[1], -wall.n[0]], slack = (wall.width - width) / 2 - corner;
      for (const t of [0, -.4, .4, -.8, .8]) {
        const offset = t * slack;
        candidates.push({ wall, width, t, at: [wall.c[0] + along[0] * offset, wall.c[1] + along[1] * offset] });
      }
    }
    const door = (c, path, access) => ({ at: c.at, n: c.wall.n, width: c.width, path, step: path.at(-1), inside: [c.at[0] - c.wall.n[0] * 1.5, c.at[1] - c.wall.n[1] * 1.5], access });
    // Straight out onto a street.
    let best = null;
    for (const c of candidates) {
      for (let d = .5; d <= grid.cell * 2; d += .5) {
        const p = [c.at[0] + c.wall.n[0] * d, c.at[1] + c.wall.n[1] * d];
        if (!walkable(grid, p[0], p[1])) continue;
        const score = d + Math.abs(c.t) * 4; // prefer a short step, then the middle of the wall
        if (!best || score < best.score) best = { score, c, path: [c.at, p] };
        break;
      }
    }
    if (best) { b.door = door(best.c, best.path, 'street'); continue; }
    const alley = fine && alleyToStreet(candidates, grid, fine, distance ||= streetDistance(grid, fine));
    b.door = alley ? door(alley.c, alley.path, 'alley') : null;
  }
  return buildings;
}

// Distance (in half-steps: 2 orthogonal, 3 diagonal) from every open cell of the fine grid to the
// nearest point that is walkable on the street grid, by repeated two-pass chamfer sweeps until
// nothing changes, so it follows winding alleys. Computed once per city.
function streetDistance(grid, fine) {
  const { cols, rows, blocked } = fine, n = cols * rows, UNKNOWN = 65534, WALL = 65535;
  const dist = new Uint16Array(n);
  for (let r = 0, i = 0; r < rows; r++) {
    const gr = Math.floor((fine.oy + (r + .5) * fine.cell - grid.oy) / grid.cell);
    for (let c = 0; c < cols; c++, i++) {
      if (blocked[i]) { dist[i] = WALL; continue; }
      const gc = Math.floor((fine.ox + (c + .5) * fine.cell - grid.ox) / grid.cell);
      dist[i] = gc >= 0 && gr >= 0 && gc < grid.cols && gr < grid.rows && !grid.blocked[gr * grid.cols + gc] ? 0 : UNKNOWN;
    }
  }
  const relax = (i, j, cost) => { if (dist[j] < WALL && dist[j] + cost < dist[i]) { dist[i] = dist[j] + cost; return true; } return false; };
  for (let pass = 0, changed = true; changed && pass < 40; pass++) {
    changed = false;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c; if (dist[i] >= WALL || dist[i] === 0) continue;
      if (c > 0) changed = relax(i, i - 1, 2) || changed;
      if (r > 0) { changed = relax(i, i - cols, 2) || changed; if (c > 0 && !blocked[i - 1] && !blocked[i - cols]) changed = relax(i, i - cols - 1, 3) || changed; if (c < cols - 1 && !blocked[i + 1] && !blocked[i - cols]) changed = relax(i, i - cols + 1, 3) || changed; }
    }
    for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c; if (dist[i] >= WALL || dist[i] === 0) continue;
      if (c < cols - 1) changed = relax(i, i + 1, 2) || changed;
      if (r < rows - 1) { changed = relax(i, i + cols, 2) || changed; if (c < cols - 1 && !blocked[i + 1] && !blocked[i + cols]) changed = relax(i, i + cols + 1, 3) || changed; if (c > 0 && !blocked[i - 1] && !blocked[i + cols]) changed = relax(i, i + cols - 1, 3) || changed; }
    }
  }
  return dist;
}

// The best candidate door with an alley out to a street: each candidate steps straight out to the
// first open fine cell, then follows the distance field downhill to the street.
function alleyToStreet(candidates, grid, fine, dist) {
  const { cols, rows, blocked } = fine;
  let best = null;
  for (const c of candidates) {
    for (let d = .3; d <= 1.6; d += fine.cell / 2) {
      const exit = [c.at[0] + c.wall.n[0] * d, c.at[1] + c.wall.n[1] * d], i = cellAt(fine, ...exit);
      if (i < 0 || blocked[i]) continue;
      if (dist[i] < 65534) {
        const score = dist[i] * fine.cell / 2 + Math.abs(c.t) * 4;
        if (!best || score < best.score) best = { score, c, exit, start: i };
      }
      break;
    }
  }
  if (!best) return null;
  const cells = [];
  for (let i = best.start, guard = 0; guard < 100000; guard++) {
    cells.push(cellCenter(fine, i));
    if (dist[i] === 0) break;
    const c = i % cols, r = (i - c) / cols;
    let next = -1;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const j = nr * cols + nc;
      if (blocked[j] || (dc && dr && (blocked[r * cols + nc] || blocked[nr * cols + c]))) continue;
      if (next < 0 || dist[j] < dist[next]) next = j;
    }
    if (next < 0 || dist[next] >= dist[i]) return null; // shouldn't happen once the field has settled
    i = next;
  }
  // Straight out through the doorway, then along the alley.
  return { c: best.c, path: [best.c.at, best.exit, ...simplifyRoute(fine, cells)] };
}

// The whole route for a street path: from inside one building, out through its door (and along
// its alley, if it has a back door) onto the street, along the street and in through the other
// building's door. Returns { points, narrow } where narrow marks alley points, drawn thinner so
// they fit between buildings. Falls back to the nearest wall when a building has no door or the
// street never reached it.
export function routeThroughDoors(street, from, to) {
  const ends = (b, point, reached) => b.door && reached !== false
    ? [b.door.inside, ...b.door.path].map(p => ({ p, narrow: b.door.access === 'alley' }))
    : [{ p: enterBuilding(point, b), narrow: false }];
  const all = [...ends(from, street[0]), ...street.map(p => ({ p, narrow: false })), ...ends(to, street.at(-1), street.reached).reverse()];
  return { points: all.map(e => e.p), narrow: all.map(e => e.narrow) };
}

// ---- Street furniture ----

// Everything sits on a folder's pavement just inside its boundary, never on the dark roads:
// streetlights at every corner and every ~20 m along each edge, with bins, benches, trees,
// hydrants and post boxes between them. Nothing goes near a building, a doorstep or a nested folder.
export const FURNITURE = { lightSpacing: 20 };
const FURNITURE_TYPES = [
  { type: 'bin', weight: 30, inset: .9, clearance: .8 },
  { type: 'bench', weight: 24, inset: 1.1, clearance: 1.2 },
  { type: 'tree', weight: 28, inset: 1.6, clearance: 1.9 },
  { type: 'hydrant', weight: 12, inset: .7, clearance: .6 },
  { type: 'postbox', weight: 6, inset: .9, clearance: .8 },
];

export function streetFurniture(blocks, buildings, random = Math.random) {
  const out = [], index = spatialIndex(buildings);
  // Keep a clear approach to every door: nothing within 2.5 m of the straight path from the door
  // out towards the road (12 m), which is where routes and people come and go.
  const approaches = buildings.filter(b => b.door && b.door.access === 'street').map(({ door }) => ({ a: door.at, n: door.n }));
  const alleyIndex = spatialIndex(buildings.filter(b => b.door && b.door.access === 'alley').flatMap(({ door }) => door.path).map(([x, y]) => ({ x, y, w: 0, h: 0 })), 16);
  const approachIndex = spatialIndex(approaches.map(({ a, n }) => ({ x: Math.min(a[0], a[0] + n[0] * 12), y: Math.min(a[1], a[1] + n[1] * 12), w: Math.abs(n[0]) * 12, h: Math.abs(n[1]) * 12, a, n })), 16);
  const onApproach = (x, y) => [...approachIndex.near(x, y, 3)].some(({ a, n }) => {
    const along = (x - a[0]) * n[0] + (y - a[1]) * n[1], across = Math.abs((x - a[0]) * n[1] - (y - a[1]) * n[0]);
    return along > -1 && along < 12 && across < 2.5;
  });
  const nested = blocks.filter(block => block.depth > 1);
  const distanceToBuildings = (x, y, radius) => {
    let nearest = Infinity;
    for (const b of index.near(x, y, radius + 1)) nearest = Math.min(nearest, Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h)));
    return nearest;
  };
  const free = (block, x, y, clearance) =>
    distanceToBuildings(x, y, clearance) >= clearance &&
    !onApproach(x, y) && [...alleyIndex.near(x, y, 2.5)].every(p => Math.hypot(p.x - x, p.y - y) > 2.5) &&
    !nested.some(o => o !== block && o.depth > block.depth && x > o.x - clearance && x < o.x + o.w + clearance && y > o.y - clearance && y < o.y + o.h + clearance);
  const pick = () => {
    let roll = random() * FURNITURE_TYPES.reduce((sum, t) => sum + t.weight, 0);
    for (const t of FURNITURE_TYPES) if ((roll -= t.weight) < 0) return t;
    return FURNITURE_TYPES[0];
  };
  for (const block of blocks) {
    if (block.depth < 1 || block.w < 6 || block.h < 6) continue;
    // Edges clockwise; `out` points away from the block, towards the road.
    const edges = [
      { a: [block.x, block.y], b: [block.x + block.w, block.y], out: [0, -1] },
      { a: [block.x + block.w, block.y], b: [block.x + block.w, block.y + block.h], out: [1, 0] },
      { a: [block.x + block.w, block.y + block.h], b: [block.x, block.y + block.h], out: [0, 1] },
      { a: [block.x, block.y + block.h], b: [block.x, block.y], out: [-1, 0] },
    ];
    for (const edge of edges) {
      const length = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]), dir = [(edge.b[0] - edge.a[0]) / length, (edge.b[1] - edge.a[1]) / length];
      const at = (distance, inset) => [edge.a[0] + dir[0] * distance - edge.out[0] * inset, edge.a[1] + dir[1] * distance - edge.out[1] * inset];
      // Lights include the edge's starting corner (each corner starts exactly one edge).
      const lights = Math.max(1, Math.round(length / FURNITURE.lightSpacing)), spacing = length / lights;
      for (let i = 0; i < lights; i++) {
        const distance = i === 0 ? .6 : i * spacing, [x, y] = at(distance, .5);
        if (free(block, x, y, .5)) out.push({ type: 'light', x, y, out: edge.out, along: dir, block });
        const between = distance + spacing / 2;
        if (between > length - 1.5) continue;
        const kind = pick(), [px, py] = at(between, kind.inset);
        if (free(block, px, py, kind.clearance)) out.push({ type: kind.type, x: px, y: py, out: edge.out, along: dir, block });
      }
    }
  }
  return out;
}

// Boxes that draw a piece of furniture: { x, y, w, h, z, height, color, part } where part is
// 'solid', 'lamp' (emissive) or 'pool' (a pool of light on the pavement).
// Box builder in a local frame at (x, y): ax/ay are offsets along `along` and `out` (axis-aligned
// unit vectors), sx/sy sizes in those directions.
function localBoxes(boxes, x, y, along, out) {
  return (ax, ay, sx, sy, z, height, color, part = 'solid') => {
    const cx = x + along[0] * ax + out[0] * ay, cy = y + along[1] * ax + out[1] * ay;
    const w = Math.abs(along[0]) * sx + Math.abs(out[0]) * sy, h = Math.abs(along[1]) * sx + Math.abs(out[1]) * sy;
    boxes.push({ x: cx - w / 2, y: cy - h / 2, w, h, z, height, color, part });
  };
}

export function furnitureBoxes(item) {
  const boxes = [], box = localBoxes(boxes, item.x, item.y, item.along, item.out);
  switch (item.type) {
    case 'light':
      box(0, 0, .18, .18, 0, 5.6, [.18, .18, .2]);
      box(0, .55, .12, 1.2, 5.45, .12, [.18, .18, .2]);
      box(0, 1.05, .45, .6, 5.2, .25, [1, .86, .55], 'lamp');
      box(0, .6, 9, 9, .38, .02, [1, .78, .42], 'pool');
      break;
    case 'bin':
      box(0, 0, .6, .6, 0, .95, [.12, .32, .2]);
      box(0, 0, .7, .7, .95, .08, [.08, .2, .13]);
      break;
    case 'bench':
      box(0, 0, 1.7, .45, 0, .42, [.2, .16, .12]);
      box(0, 0, 1.8, .5, .42, .08, [.55, .36, .2]);
      box(0, -.24, 1.8, .08, .5, .5, [.55, .36, .2]);
      break;
    case 'tree':
      // Canopy starts above head height so walkers pass underneath.
      box(0, 0, .32, .32, 0, 3.4, [.3, .2, .12]);
      box(0, 0, 2.4, 2.4, 3, 1.5, [.16, .42, .2]);
      box(0, 0, 1.6, 1.6, 4.5, 1, [.2, .5, .24]);
      break;
    case 'hydrant':
      box(0, 0, .32, .32, 0, .6, [.85, .72, .1]);
      box(0, 0, .42, .2, .38, .12, [.7, .58, .08]);
      break;
    case 'postbox':
      box(0, 0, .55, .55, 0, 1.2, [.78, .08, .08]);
      box(0, 0, .65, .65, 1.2, .14, [.6, .05, .05]);
      break;
  }
  return boxes;
}

// ---- Traffic ----

// Cars circle the blocks inside a folder, on its grey streets: one lane per block, half-way into the
// road around it, driving with the kerb on their right. Top-level districts border the black ground
// and get no traffic. Neighbouring blocks are a full road apart, so no two loops ever meet.
export const TRAFFIC = { minRoad: 2.5, spacing: 55, length: 4.2, width: 1.8 };
export function trafficLoops(blocks) {
  return blocks.filter(b => b.depth > 1 && b.road >= TRAFFIC.minRoad).map(b => {
    const o = b.road / 2, x0 = b.x - o, y0 = b.y - o, x1 = b.x + b.w + o, y1 = b.y + b.h + o;
    // Clockwise, matching the furniture edges: right of travel (-dy, dx) points into the block.
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    return { corners, length: 2 * (x1 - x0 + y1 - y0) };
  });
}

// Cars on one loop share a speed and start evenly spaced, so they never catch each other up.
export function spawnCars(loops, random = Math.random) {
  const cars = [];
  for (const loop of loops) {
    const count = Math.floor(loop.length / TRAFFIC.spacing + random());
    if (!count) continue;
    const speed = 6 + random() * 6, start = random() * loop.length;
    for (let i = 0; i < count; i++) cars.push({ loop, speed, s: start + i * loop.length / count, color: CAR_COLOURS[Math.floor(random() * CAR_COLOURS.length)] });
  }
  return cars;
}
const CAR_COLOURS = [[.75, .1, .1], [.1, .3, .7], [.85, .85, .8], [.12, .12, .14], [.9, .6, .1], [.2, .5, .35], [.5, .52, .55]];

// Where a car is along its loop: position and axis-aligned travel direction.
export function carPose(car) {
  const { corners, length } = car.loop;
  let s = ((car.s % length) + length) % length;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], edge = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    if (s <= edge || i === 3) {
      const dir = [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])], t = Math.min(s, edge);
      return { x: a[0] + dir[0] * t, y: a[1] + dir[1] * t, dir };
    }
    s -= edge;
  }
}

// Moves the traffic on. Cars stop for someone standing in the lane just ahead of them, and the rest
// of that loop waits too, so nobody drives into the car in front.
export function stepCars(cars, dt, eye = null) {
  const waiting = new Set();
  if (eye) for (const car of cars) {
    const { x, y, dir } = carPose(car), ahead = (eye[0] - x) * dir[0] + (eye[1] - y) * dir[1];
    if (ahead > 0 && ahead < TRAFFIC.length / 2 + 4 && Math.abs((eye[0] - x) * dir[1] - (eye[1] - y) * dir[0]) < TRAFFIC.width / 2 + .8) waiting.add(car.loop);
  }
  for (const car of cars) if (!waiting.has(car.loop)) car.s += car.speed * dt;
}

// Body, cabin, wheels, head and tail lights, and a pool of headlight on the road ahead.
export function carBoxes(car) {
  const { x, y, dir } = carPose(car), boxes = [], box = localBoxes(boxes, x, y, dir, [-dir[1], dir[0]]);
  const { length: l, width: w } = TRAFFIC, dark = [.05, .05, .06];
  for (const ax of [-l * .3, l * .3]) box(ax, 0, .7, w + .1, 0, .6, dark);
  box(0, 0, l, w, .3, .75, car.color);
  box(-l * .08, 0, l * .5, w * .88, 1.05, .6, car.color.map(c => c * .7));
  for (const ay of [-w * .32, w * .32]) {
    box(l / 2, ay, .08, .38, .65, .22, [1, .95, .8], 'lamp');
    box(-l / 2, ay, .08, .38, .65, .2, [.9, .05, .04], 'lamp');
  }
  box(l / 2 + 4, 0, 7, 7, .42, .02, [.9, .88, .75], 'pool');
  return boxes;
}
