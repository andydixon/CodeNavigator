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

import { bladeSigns, readableFrom } from '../web/city.js';

test('blade signs project from the wall and exactly one face reads from either side', () => {
  const south = { x: 0, y: 0, w: 20, h: 10, height: 30 };
  const blades = bladeSigns(south, [5, 14, 1.7], 4);
  assert.equal(blades.length, 2, 'one blade (two faces) on the south wall only');
  const [a, b] = blades;
  assert.ok(Math.abs(a.u[0]) < 1e-9 && a.u[1] > 0 && a.c[1] > 10, 'perpendicular to the wall, outside it');
  for (const eye of [[-5, 14, 1.7], [25, 14, 1.7]]) {
    assert.equal(readableFrom(a, eye) + readableFrom(b, eye), 1, `one readable face from ${eye}`);
  }
  assert.ok(readableFrom(flatQuad(0, 0, 0, 4, 1), [0, 0, 50]), 'ground labels read from above');
});

test('blades shrink to the free space and are skipped when a neighbour is too close', () => {
  const b = { x: 0, y: 0, w: 20, h: 10, height: 30 };
  assert.ok(bladeSigns(b, [5, 30, 1.7], 10, () => 2.5)[0].u[1] * 2 <= 2.5 - .65 + 1e-9);
  assert.equal(bladeSigns(b, [5, 30, 1.7], 10, () => 1).length, 0);
  assert.equal(bladeSigns({ x: 0, y: 0, w: 100, h: 10, height: 30 }, [50, 30, 1.7], 4).length, 8, 'repeats along long walls');
});
