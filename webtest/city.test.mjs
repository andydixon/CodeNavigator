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
