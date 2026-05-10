import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perspective, lookAt, multiply, transform, invert, orbitPose, ORBIT_FOV } from '../web/camera.js';

// The landscape projection before the real camera, kept as the reference.
function legacyProject(camera, [x, y, z], width, height) {
  let px = (x - camera.x) / 420, py = (y - camera.y) / 420, pz = z / 170;
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  [px, py] = [cy * px - sy * py, sy * px + cy * py]; [py, pz] = [cp * py + sp * pz, -sp * py + cp * pz];
  const depth = camera.distance - py, aspect = width / height;
  return { x: width / 2 + (px / (depth * aspect) * 2.7) * width / 2, y: height / 2 - ((pz - .35) / depth * 2.7) * height / 2, depth };
}

test('orbit camera reproduces the legacy landscape projection', () => {
  const width = 1280, height = 800;
  for (const camera of [{ x: 500, y: 340, yaw: -.12, pitch: .76, distance: 3.5 }, { x: 120, y: 600, yaw: 2.4, pitch: .2, distance: 1.1 }, { x: 800, y: 50, yaw: -1.3, pitch: 1.4, distance: 7 }]) {
    const pose = orbitPose(camera);
    const viewProj = multiply(perspective(ORBIT_FOV, width / height, 1, 100000), lookAt(pose.eye, pose.target, pose.up));
    for (const point of [[500, 340, 0], [0, 0, 40], [1000, 680, 12], [430, 200, 80]]) {
      const legacy = legacyProject(camera, point, width, height);
      if (legacy.depth < .6) continue;
      const [cx, cy, , cw] = transform(viewProj, point[0], point[1], point[2] * 420 / 170);
      const x = (cx / cw + 1) / 2 * width, y = (1 - cy / cw) / 2 * height;
      assert.ok(Math.abs(x - legacy.x) < .05 && Math.abs(y - legacy.y) < .05, `${JSON.stringify(camera)} ${point}: got ${x},${y} want ${legacy.x},${legacy.y}`);
      assert.ok(Math.abs(cw / 420 - legacy.depth) < 1e-3, `depth ${cw / 420} vs ${legacy.depth}`);
    }
  }
});

test('invert undoes a view-projection', () => {
  const m = multiply(perspective(1, 1.5, .1, 1000), lookAt([3, 4, 5], [0, 0, 0]));
  const inv = invert(m), id = multiply(m, inv);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(id[i] - (i % 5 === 0 ? 1 : 0)) < 1e-4, `${i}: ${id[i]}`);
});
