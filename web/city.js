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
  camera.ex = Math.max(-150, Math.min(bounds.width + 150, x));
  camera.ey = Math.max(-150, Math.min(bounds.height + 150, y));
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

// Name signs at first-floor height on the walls that face the viewer.
export function wallSigns(b, eye, aspect, height = .9, z = 3.2) {
  const out = [];
  for (const wall of walls(b)) {
    if ((eye[0] - wall.c[0]) * wall.n[0] + (eye[1] - wall.c[1]) * wall.n[1] <= 0) continue;
    // Long walls repeat the sign every ~24 m so one is always near someone walking past.
    const count = Math.max(1, Math.floor(wall.width / 24)), segment = wall.width / count, along = [wall.n[1], -wall.n[0]];
    const width = Math.min(segment * .85, aspect * height);
    for (let i = 0; i < count; i++) {
      const offset = (i + .5) * segment - wall.width / 2;
      out.push(wallQuad({ ...wall, c: [wall.c[0] + along[0] * offset, wall.c[1] + along[1] * offset] }, Math.min(z, b.height * .5), width, width / aspect));
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
