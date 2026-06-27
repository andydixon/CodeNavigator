import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShelfPacker } from '../web/labels.js';
import { flatQuad, wallSigns, facadeQuad } from '../web/city.js';

test('shelf packer fills rows then reports full', () => {
  const packer = new ShelfPacker(100, 20, 10);
  assert.deepEqual(packer.add(60), { x: 0, y: 0, w: 60, h: 10 });
  assert.deepEqual(packer.add(60), { x: 0, y: 10, w: 60, h: 10 });
  assert.deepEqual(packer.add(30), { x: 62, y: 10, w: 30, h: 10 });
  assert.equal(packer.add(30), null);
  packer.reset();
  assert.deepEqual(packer.add(500), { x: 0, y: 0, w: 100, h: 10 });
});

const building = { x: 0, y: 0, w: 20, h: 10, height: 30 };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

test('wall signs only appear on walls facing the viewer and read left to right', () => {
  const south = wallSigns(building, [10, 50, 1.7], 4);
  assert.equal(south.length, 1);
  assert.ok(south[0].c[1] > 10 && south[0].u[0] > 0, 'south wall reads along +x for a viewer looking north');
  const corner = wallSigns(building, [40, 40, 1.7], 4);
  assert.equal(corner.length, 2);
  for (const quad of corner) {
    // u x v points out of the wall toward the viewer when text reads correctly (left-handed world).
    const normal = cross(quad.u, quad.v), toEye = [40 - quad.c[0], 40 - quad.c[1], 0];
    assert.ok(normal[0] * toEye[0] + normal[1] * toEye[1] < 0);
  }
  assert.ok(wallSigns(building, [10, 50, 1.7], 100)[0].u[0] * 2 <= 20 * .85 + 1e-9, 'long names shrink to the wall');
  const long = wallSigns({ x: 0, y: 0, w: 100, h: 10, height: 30 }, [50, 50, 1.7], 4);
  assert.equal(long.length, 4, 'a 100 m wall repeats its sign');
  assert.ok(long.every(quad => quad.c[1] > 10) && new Set(long.map(quad => Math.round(quad.c[0]))).size === 4);
});

test('facade covers the most squarely facing wall within the building', () => {
  const quad = facadeQuad(building, [60, 5, 1.7], .5);
  assert.ok(quad.c[0] > 20, 'east wall');
  const height = quad.v[2] * 2, width = Math.hypot(quad.u[0], quad.u[1]) * 2;
  assert.ok(Math.abs(width / height - .5) < 1e-9 && quad.c[2] + height / 2 <= building.height);
  assert.deepEqual(flatQuad(1, 2, 3, 4, 2), { c: [1, 2, 3], u: [2, 0, 0], v: [0, -1, 0] });
});

import { folderBlades, folderLabel, readableFrom } from '../web/city.js';

// A 2x2 grid of buildings inside a block whose kerb is 2.5 m from the boundary.
const block = { x: 0, y: 0, w: 50, h: 50 };
const grid = [
  { x: 2.5, y: 2.5, w: 20, h: 20, height: 30 }, { x: 27.5, y: 2.5, w: 20, h: 20, height: 30 },
  { x: 2.5, y: 27.5, w: 20, h: 20, height: 30 }, { x: 27.5, y: 27.5, w: 20, h: 20, height: 30 },
];

test('folder blades sit at every block corner, on street-facing walls, pointing outward', () => {
  const blades = folderBlades(block, grid, null, 4);
  assert.equal(blades.length, 16, 'two walls per corner, two faces per blade');
  for (let i = 0; i < blades.length; i += 2) {
    const [a, b] = [blades[i], blades[i + 1]];
    const outward = [Math.sign(a.u[0]), Math.sign(a.u[1])];
    const corner = [a.c[0] < 25 ? 0 : 50, a.c[1] < 25 ? 0 : 50];
    assert.ok(Math.hypot(a.c[0] - corner[0], a.c[1] - corner[1]) < 6, `near its corner: ${a.c}`);
    assert.ok(outward[0] ? (outward[0] > 0) === (a.c[0] > 25) : (outward[1] > 0) === (a.c[1] > 25), 'projects into the street');
    for (const eye of [[a.c[0] + a.v[2] * 0 + (a.u[1] ? 10 : 0), a.c[1] + (a.u[0] ? 10 : 0), 2], [a.c[0] - (a.u[1] ? 10 : 0), a.c[1] - (a.u[0] ? 10 : 0), 2]]) {
      assert.equal(readableFrom(a, eye) + readableFrom(b, eye), 1);
    }
  }
});

test('courtyard walls, hidden walls and cramped gaps get no blades', () => {
  const inner = [{ x: 10, y: 10, w: 30, h: 30, height: 30 }];
  assert.equal(folderBlades(block, inner, null, 4).length, 0, 'set back from the street');
  const northOnly = folderBlades(block, grid, [25, -40, 1.7], 4);
  assert.ok(northOnly.length === 4 && northOnly.every(q => q.c[1] < 2.5), 'only walls facing the viewer');
  assert.equal(folderBlades(block, grid, null, 4, () => 1).length, 0);
  assert.ok(readableFrom(flatQuad(0, 0, 0, 4, 1), [0, 0, 50]), 'ground labels read from above');
});

test('folder labels keep the tail of long paths', () => {
  assert.equal(folderLabel('', 'prometheus'), 'prometheus');
  assert.equal(folderLabel('tsdb/chunks', 'x'), 'tsdb/chunks');
  const long = folderLabel('web/ui/react-app/src/pages/graph/components', 'x');
  assert.ok(long.startsWith('…/') && long.endsWith('graph/components') && long.length <= 34 + 2, long);
});

import { alertsByPath, burns, tapeQuads } from '../web/city.js';

test('alerts group by file with the worst severity', () => {
  const byPath = alertsByPath({ available: true, codeScanning: { alerts: [{ path: 'a.go', severity: 'medium' }, { path: 'a.go', severity: 'critical' }] }, dependabot: { alerts: [{ path: 'go.mod', severity: 'low' }, { path: '', severity: 'high' }] } });
  assert.equal(byPath.size, 2);
  assert.equal(byPath.get('a.go').worst, 'critical');
  assert.equal(byPath.get('a.go').codeScanning.length, 2);
  assert.equal(byPath.get('go.mod').dependabot.length, 1);
  assert.equal(alertsByPath({ available: false, reason: 'signin' }).size, 0);
  assert.ok(burns('high') && burns('critical') && !burns('medium') && !burns(undefined));
});

test('hazard tape crosses each wall corner to corner, readable from outside', () => {
  const b = { x: 0, y: 0, w: 20, h: 10, height: 40 };
  for (const direction of [1, -1]) {
    const quads = tapeQuads(b, 6, direction);
    const south = quads.filter(q => q.c[1] > 10);
    const length = south.reduce((sum, q) => sum + Math.hypot(...q.u) * 2, 0);
    assert.ok(Math.abs(length - Math.hypot(20, 40)) < 1e-6, `covers the diagonal: ${length}`);
    const [first, last] = [south[0], south.at(-1)];
    assert.ok(direction > 0 ? first.c[2] < last.c[2] : first.c[2] > last.c[2], 'runs the right way');
    assert.ok(south.every(q => q.c[2] >= 0 && q.c[2] <= 40 && q.c[0] >= 0 && q.c[0] <= 20));
    assert.ok(south.every(q => readableFrom(q, [10, 60, 20])) && south.every(q => !readableFrom(q, [10, 5, 20])));
    assert.ok(south.at(-1).fraction <= 1 && south.slice(0, -1).every(q => q.fraction === 1));
    assert.equal(new Set(quads.map(q => `${Math.sign(q.c[0] - 10)},${Math.sign(q.c[1] - 5)}`)).size >= 4, true, 'all four walls');
  }
  assert.equal(tapeQuads({ x: 0, y: 0, w: 2, h: 2, height: 30 }, 6).length, 0, 'too narrow for tape');
});
