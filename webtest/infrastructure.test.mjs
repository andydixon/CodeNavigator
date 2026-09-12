import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutCity, buildNavGrid, routesFrom, assignDoors, routeThroughDoors, ribbonVertices, streetFurniture, furnitureBoxes, walkable, DOOR, seededRandom } from '../web/city.js';

const ROUTE_MARGIN = 2;
function city() {
  const files = []; let id = 1;
  for (let d = 0; d < 12; d++) for (let s = 0; s < 4; s++) for (let f = 0; f < (s === 0 ? 40 : 6); f++) files.push({ id: id++, path: `dir${d}/sub${s}/file${f}.go`, lines: 60 + (id * 7919) % 2500, complexity: (id * 31) % 150 });
  const model = layoutCity(files, 'x'), buildings = [...model.buildings.values()];
  const grid = buildNavGrid(buildings, model.blocks, model, 3, ROUTE_MARGIN);
  assignDoors(buildings, grid, buildNavGrid(buildings, [], model, .5, .3));
  return { model, buildings, grid };
}
const inside = (b, x, y, pad = 0) => x > b.x + pad && x < b.x + b.w - pad && y > b.y + pad && y < b.y + b.h - pad;
const distance = (b, x, y) => Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h));

test('every door sits on its building wall, away from corners, with an open doorstep', () => {
  const { buildings, grid } = city();
  const withDoors = buildings.filter(b => b.door);
  assert.ok(withDoors.length / buildings.length > .97, `nearly every building has a door (${withDoors.length}/${buildings.length})`);
  assert.ok(withDoors.some(b => b.door.access === 'alley') && withDoors.some(b => b.door.access === 'street'));
  for (const b of withDoors) {
    const { at, n, width, step, path } = b.door;
    assert.deepEqual(path[0], at);
    for (let i = 1; i < path.length; i++) for (const other of buildings) assert.ok(!inside(other, ...path[i], .05), 'door path stays out of buildings');
    assert.ok(distance(b, ...at) < 1e-6, 'on the wall');
    const cornerX = Math.min(at[0] - b.x, b.x + b.w - at[0]), cornerY = Math.min(at[1] - b.y, b.y + b.h - at[1]);
    const alongCorner = n[0] ? cornerY : cornerX, wallWidth = n[0] ? b.h : b.w;
    assert.ok(alongCorner >= width / 2 + Math.min(DOOR.cornerClearance, wallWidth * .2) - 1e-6, `door clear of the corner: ${alongCorner}`);
    assert.ok(walkable(grid, ...step), 'doorstep is on the street');
    assert.ok((path[1][0] - at[0]) * n[0] + (path[1][1] - at[1]) * n[1] > 0, 'path leaves through the wall');
    assert.ok(inside(b, ...b.door.inside), 'inside point is inside');
  }
});

test('routes leave and enter through doors and never clip another building', () => {
  const { buildings, grid } = city();
  const source = buildings.find(b => b.door?.access === 'alley'), targets = buildings.filter(b => b !== source && b.door).filter((_, i) => i % 5 === 0).slice(0, 30);
  assert.ok(targets.some(t => t.door.access === 'alley'));
  const streets = routesFrom(grid, source, targets);
  const halfWidth = .8 + 1.3 / 2; // lane offset plus half the ribbon
  let checked = 0;
  streets.forEach((street, t) => {
    assert.ok(street && street.reached, `target ${t} reached by street`);
    const { points, narrow } = routeThroughDoors(street, source, targets[t]);
    assert.deepEqual(points[0], source.door.inside);
    assert.deepEqual(points[1], source.door.at);
    assert.deepEqual(points.at(-1), targets[t].door.inside);
    assert.equal(narrow.length, points.length);
    // Everything between the two door frames: ribbon edges stay out of every building.
    const verts = ribbonVertices([{ points: points.slice(1, -1), narrow: narrow.slice(1, -1), kind: 0 }]);
    const segments = verts.length / 36;
    for (let i = 0; i < verts.length; i += 6) {
      const segment = Math.floor(i / 36);
      if (segment === 0 || segment === segments - 1) continue; // the door segments touch their own walls
      for (const b of buildings) assert.ok(!inside(b, verts[i], verts[i + 1], .05), `ribbon vertex ${verts[i]},${verts[i + 1]} inside a building`);
      checked++;
    }
    // Door segments are perpendicular to the wall.
    const [a, d] = [points[1], points[2]], n = source.door.n;
    assert.ok(Math.abs((d[0] - a[0]) * n[1] - (d[1] - a[1]) * n[0]) < 1e-9);
  });
  assert.ok(checked > 50);
  assert.ok(halfWidth < ROUTE_MARGIN);
});

test('street furniture stays on pavements along folder edges, clear of buildings and doors', () => {
  const { model, buildings } = city();
  const items = streetFurniture(model.blocks, buildings, seededRandom(4));
  const lights = items.filter(i => i.type === 'light');
  assert.ok(lights.length > 50, `plenty of lights (${lights.length})`);
  assert.ok(new Set(items.map(i => i.type)).size >= 5, 'a mix of furniture');
  for (const item of items) {
    const block = item.block;
    assert.ok(block.depth >= 1 && inside(block, item.x, item.y), 'on a folder pavement, not the road');
    for (const b of buildings) assert.ok(distance(b, item.x, item.y) >= .5, `${item.type} clear of buildings`);
    for (const b of buildings) if (b.door) {
      const { at, n } = b.door, along = (item.x - at[0]) * n[0] + (item.y - at[1]) * n[1], across = Math.abs((item.x - at[0]) * n[1] - (item.y - at[1]) * n[0]);
      assert.ok(!(along > -1 && along < 12 && across < 2.5), `${item.type} not on a door's approach`);
    }
    for (const box of furnitureBoxes(item)) if (box.part !== 'pool' && box.part !== 'lamp' && box.z < 2) {
      assert.ok(inside(block, box.x, box.y, -1e-6) && inside(block, box.x + box.w, box.y + box.h, -1e-6), `${item.type} footprint within its pavement`);
    }
  }
  for (const light of lights) {
    const b = light.block, edge = Math.min(light.x - b.x, b.x + b.w - light.x, light.y - b.y, b.y + b.h - light.y);
    assert.ok(Math.abs(edge - .5) < 1e-6, `light on the folder boundary line (${edge})`);
  }
});
