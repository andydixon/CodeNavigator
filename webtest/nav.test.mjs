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
