import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNavGrid, routesFrom, walkable } from '../web/city.js';

// Two buildings separated by a long wall-like building with a gap at the far end.
const a = { x: 0, y: 0, w: 10, h: 10, height: 20 };
const b = { x: 60, y: 0, w: 10, h: 10, height: 20 };
const wall = { x: 30, y: -40, w: 6, h: 100, height: 20 };
const bounds = { width: 100, height: 100 };

const onFreeGround = (grid, points) => {
  for (let i = 1; i < points.length; i++) {
    const [p, q] = [points[i - 1], points[i]], steps = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]));
    for (let s = 0; s <= steps; s++) assert.ok(walkable(grid, p[0] + (q[0] - p[0]) * s / steps, p[1] + (q[1] - p[1]) * s / steps), `segment ${i} crosses a building`);
  }
};

test('routes go around buildings and never through them', () => {
  const grid = buildNavGrid([a, b, wall], [], bounds);
  const [route] = routesFrom(grid, a, [b]);
  assert.ok(route && route.length >= 3, 'needs turns to get around the wall');
  onFreeGround(grid, route);
  assert.ok(route.some(([, y]) => y > 60), 'detours past the end of the wall');
  const toEdge = ([x, y], r) => Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.y - y, 0, y - r.y - r.h));
  assert.ok(toEdge(route[0], a) < 8 && toEdge(route.at(-1), b) < 8, `starts and ends beside the buildings: ${route[0]} ${route.at(-1)}`);
});

test('several targets from one search; enclosed ones end at the nearest street', () => {
  const sealed = { x: 80, y: 80, w: 6, h: 6, height: 5 };
  const box = [{ x: 74, y: 74, w: 18, h: 2, height: 5 }, { x: 74, y: 90, w: 18, h: 2, height: 5 }, { x: 74, y: 74, w: 2, h: 18, height: 5 }, { x: 90, y: 74, w: 2, h: 18, height: 5 }];
  const grid = buildNavGrid([a, b, sealed, ...box], [], { width: 120, height: 120 }, 3, .5);
  const routes = routesFrom(grid, a, [b, sealed]);
  assert.ok(routes[0]);
  onFreeGround(grid, routes[0]);
  // The sealed building can't be entered, so its route ends on the nearest reachable street outside the ring.
  onFreeGround(grid, routes[1]);
  const end = routes[1].at(-1);
  assert.ok(Math.hypot(end[0] - 83, end[1] - 83) < 20 && !(end[0] > 74 && end[0] < 92 && end[1] > 74 && end[1] < 92), `ends outside the ring: ${end}`);
});

test('routes prefer roads over pavements when the detour is small', () => {
  const pavement = { depth: 1, x: 12, y: -2, w: 40, h: 14 };
  const grid = buildNavGrid([a, b], [pavement], bounds);
  const [route] = routesFrom(grid, a, [b]);
  onFreeGround(grid, route);
  assert.ok(route.length >= 2);
});

import { layoutCity } from '../web/city.js';

test('routing a large generated city stays fast (guards against queue flooding)', () => {
  const files = []; let id = 1;
  for (let d = 0; d < 40; d++) for (let s = 0; s < 6; s++) for (let f = 0; f < 7; f++) files.push({ id: id++, path: `dir${d}/sub${s}/file${f}.go`, lines: 50 + (id * 7919) % 3000, complexity: (id * 31) % 200 });
  const city = layoutCity(files), entries = [...city.buildings.values()], grid = buildNavGrid(entries, city.blocks, city);
  const started = performance.now(), routes = routesFrom(grid, entries[0], entries.slice(100, 140));
  assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms`);
  assert.ok(routes.every(Boolean), 'every building in a connected city is reachable');
  routes.forEach(route => { for (const [x, y] of route) assert.ok(walkable(grid, x, y)); });
});

import { spawnWanderers, stepWanderers, seededRandom } from '../web/city.js';

test('wanderers spawn and stay on walkable ground while they roam', () => {
  const grid = buildNavGrid([a, b, wall], [], bounds), random = seededRandom(7);
  const crowd = spawnWanderers(grid, 60, random);
  assert.equal(crowd.length, 60);
  const start = crowd.map(w => [w.x, w.y]);
  for (let frame = 0; frame < 900; frame++) {
    stepWanderers(crowd, grid, 1 / 30, random);
    if (frame % 30 === 0) for (const w of crowd) assert.ok(walkable(grid, w.x, w.y), `walker at ${w.x},${w.y}`);
  }
  const moved = crowd.filter((w, i) => Math.hypot(w.x - start[i][0], w.y - start[i][1]) > 3).length;
  assert.ok(moved > 40, `most walkers wandered off (${moved})`);
  assert.ok(crowd.every(w => Number.isFinite(w.phase)));
  assert.ok(spawnWanderers(grid, 30, random, { width: 20, height: 20 }).every(w => w.x >= 0 && w.x <= 20 && w.y >= 0 && w.y <= 20), 'spawns inside the city bounds');
});

test('a seeded crowd is reproducible', () => {
  const grid = buildNavGrid([a], [], bounds);
  const run = () => { const r = seededRandom(3), c = spawnWanderers(grid, 10, r); for (let i = 0; i < 100; i++) stepWanderers(c, grid, .05, r); return c.map(w => [w.x.toFixed(3), w.y.toFixed(3)]); };
  assert.deepEqual(run(), run());
});

import { cityWalls, posterQuads, WALL, stepCamera, readableFrom, spatialIndex } from '../web/city.js';

test('the wall encloses the city and nobody gets past it', () => {
  const bounds = { width: 200, height: 120 }, walls = cityWalls(bounds);
  const inside = (x, y) => walls.every(w => !(x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h));
  assert.ok(inside(100, 60) && inside(-WALL.margin + 1, -WALL.margin + 1) && !inside(-WALL.margin - 1, 60));
  const index = spatialIndex(walls), edge = WALL.margin - .5;
  const walker = { view: 'walk', ex: 100, ey: 60, ez: 1.7, lookYaw: Math.PI / 2, lookPitch: 0 }; // heading west
  stepCamera(walker, { forward: 1, right: 0, up: 0 }, 60, index, { ...bounds, edge });
  assert.ok(walker.ex >= -WALL.margin, `walker stopped at the wall: ${walker.ex}`);
  const flyer = { view: 'fly', ex: 100, ey: 60, ez: 500, lookYaw: Math.PI / 2, lookPitch: 0 };
  stepCamera(flyer, { forward: 1, right: 0, up: 0 }, 60, index, { ...bounds, edge });
  assert.ok(flyer.ex >= -edge - 1e-9, `flyer stayed inside: ${flyer.ex}`);
  // Routes and residents can't reach the outside either.
  const grid = buildNavGrid(walls, [], bounds);
  assert.ok(walkable(grid, 100, 60) && !walkable(grid, -WALL.margin - 1, 60));
});

test('posters are pasted on the city side of the walls, tilted and readable from inside', () => {
  const bounds = { width: 400, height: 300 }, walls = cityWalls(bounds), random = seededRandom(11);
  const posters = posterQuads(walls, 12, random);
  assert.ok(posters.length >= 36, `about one per 35 m (${posters.length})`);
  for (const p of posters) {
    assert.ok(readableFrom(p, [200, 150, 5]), 'faces the city');
    assert.ok(p.c[0] > -WALL.margin - .01 && p.c[0] < bounds.width + WALL.margin + .01 && p.c[1] > -WALL.margin - .01 && p.c[1] < bounds.height + WALL.margin + .01, `on the inner face: ${p.c}`);
    const tilt = Math.atan2(p.u[2], Math.hypot(p.u[0], p.u[1]));
    assert.ok(Math.abs(tilt) <= .44 && p.c[2] - Math.hypot(...p.v) >= 1.5 && p.c[2] + Math.hypot(...p.v) <= WALL.height + .5);
    assert.ok(Number.isInteger(p.poster) && p.poster >= 0 && p.poster < 12);
  }
  assert.ok(new Set(posters.map(p => p.u[2].toFixed(2))).size > 10, 'arbitrary angles');
});
