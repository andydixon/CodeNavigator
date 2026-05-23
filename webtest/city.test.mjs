import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutCity, buildingHeight, spatialIndex, rayBox, pickRay, CITY } from '../web/city.js';

function sampleFiles() {
  const files = []; let id = 1;
  for (const dir of ['src/core', 'src/ui/widgets', 'tests', 'docs', 'vendor/lib', '']) {
    for (let i = 0; i < 12; i++) files.push({ id: id++, path: `${dir ? dir + '/' : ''}file${i}.js`, lines: 20 + (i * 137) % 900, complexity: i * 3 });
  }
  return files;
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('every file gets a building inside the city, and buildings never overlap', () => {
  const files = sampleFiles(), city = layoutCity(files, 'demo');
  assert.equal(city.buildings.size, files.length);
  const list = [...city.buildings.values()];
  for (const b of list) {
    assert.ok(b.w > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.x + b.w <= city.width + 1e-6 && b.y + b.h <= city.height + 1e-6, JSON.stringify(b));
  }
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(!overlaps(list[i], list[j]), `${i} overlaps ${j}`);
});

test('top-level districts are separated by an avenue', () => {
  const city = layoutCity(sampleFiles(), 'demo');
  const districts = city.blocks.filter(block => block.depth === 1);
  assert.ok(districts.length >= 4);
  for (let i = 0; i < districts.length; i++) for (let j = i + 1; j < districts.length; j++) {
    const a = districts[i], b = districts[j];
    const gap = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
    assert.ok(gap >= CITY.roadWidths[0] * .99 || gap >= Math.min(a.w, a.h, b.w, b.h) * .39, `gap ${gap}`);
  }
});

test('the city grows with the codebase and is deterministic', () => {
  const small = layoutCity(sampleFiles().slice(0, 10)), large = layoutCity(sampleFiles());
  assert.ok(large.width * large.height > small.width * small.height * 3);
  assert.deepEqual([...layoutCity(sampleFiles()).buildings], [...large.buildings]);
});

test('complex files are taller', () => {
  assert.ok(buildingHeight({ complexity: 200 }) > buildingHeight({ complexity: 3 }));
  assert.equal(buildingHeight({}), 6);
});

test('rays hit the nearest box and miss empty space', () => {
  const near = { x: 10, y: -1, w: 2, h: 2, height: 5 }, far = { x: 30, y: -1, w: 2, h: 2, height: 50 };
  assert.equal(rayBox([0, 0, 1], [1, 0, 0], near), 10);
  assert.equal(rayBox([0, 0, 6], [1, 0, 0], near), Infinity);
  assert.equal(pickRay([0, 0, 1], [1, 0, 0], [far, near]).entry, near);
  assert.equal(pickRay([0, 0, 1], [-1, 0, 0], [far, near]), null);
  assert.equal(pickRay([0, 0, 1], [1, 0, 0], [far, near], 5), null);
});

test('spatial index finds boxes near a point', () => {
  const a = { x: 0, y: 0, w: 5, h: 5 }, b = { x: 200, y: 200, w: 5, h: 5 };
  const index = spatialIndex([a, b]);
  assert.deepEqual([...index.near(2, 2, 3)], [a]);
  assert.deepEqual([...index.near(100, 100, 3)], []);
});

import { collide, heading, stepCamera, blockAt, groundHit, MOVE } from '../web/city.js';

test('collision pushes a walker out of buildings but leaves streets alone', () => {
  const box = { x: 0, y: 0, w: 10, h: 10, height: 20 }, index = spatialIndex([box]);
  assert.deepEqual(collide(20, 20, .5, index), { x: 20, y: 20 });
  const edge = collide(10.2, 5, .5, index);
  assert.ok(Math.abs(edge.x - 10.5) < 1e-9 && edge.y === 5);
  const inside = collide(9, 5, .5, index);
  assert.ok(Math.abs(inside.x - 10.5) < 1e-9, `inside exits nearest wall: ${inside.x}`);
});

test('headings are orthogonal and yaw 0 faces north', () => {
  for (const yaw of [0, .7, 2, -2.5]) {
    const { forward, right } = heading(yaw);
    assert.ok(Math.abs(forward[0] * right[0] + forward[1] * right[1]) < 1e-12);
  }
  assert.deepEqual(heading(0).forward.map(v => Math.round(v)), [-0, -1]);
});

test('walking moves at walking speed, collides, and stays on the ground', () => {
  const index = spatialIndex([{ x: -5, y: -20, w: 10, h: 5, height: 30 }]);
  const cam = { view: 'walk', ex: 0, ey: 0, ez: 1.7, lookYaw: 0, lookPitch: .5 };
  stepCamera(cam, { forward: 1, right: 0, up: 1 }, 1, index, { width: 100, height: 100 });
  assert.ok(Math.abs(cam.ey + MOVE.walk) < 1e-9 && cam.ez === MOVE.eyeHeight);
  stepCamera(cam, { forward: 1, right: 0, up: 0 }, 2, index, { width: 100, height: 100 });
  assert.ok(cam.ey >= -15 + MOVE.radius - 1e-9, `stopped at the wall, got ${cam.ey}`);
});

test('flying climbs with the view and clears low roofs', () => {
  const index = spatialIndex([{ x: -5, y: -20, w: 10, h: 5, height: 10 }]);
  const cam = { view: 'fly', ex: 0, ey: 0, ez: 50, lookYaw: 0, lookPitch: 0 };
  stepCamera(cam, { forward: 1, right: 0, up: 0 }, 1, index, { width: 100, height: 100 });
  assert.ok(cam.ey < -30, 'flew over the low building');
  stepCamera(cam, { forward: 0, right: 0, up: -1 }, 10, index, { width: 100, height: 100 });
  assert.equal(cam.ez, MOVE.eyeHeight);
});

test('addresses resolve to the deepest block and rays find the ground', () => {
  const blocks = [{ depth: 0, x: 0, y: 0, w: 100, h: 100 }, { depth: 1, x: 0, y: 0, w: 50, h: 50, node: { path: 'src' } }, { depth: 2, x: 10, y: 10, w: 10, h: 10, node: { path: 'src/ui' } }];
  assert.equal(blockAt(blocks, 15, 15).node.path, 'src/ui');
  assert.equal(blockAt(blocks, 40, 40).node.path, 'src');
  assert.equal(blockAt(blocks, 90, 90), null);
  assert.deepEqual(groundHit([0, 0, 10], [0, Math.SQRT1_2, -Math.SQRT1_2]).map(v => Math.round(v)), [0, 10]);
  assert.equal(groundHit([0, 0, 10], [0, 0, 1]), null);
});
