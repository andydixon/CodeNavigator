// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Andy Dixon
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tourStops, encodePlace, decodePlace, joystick } from '../web/city.js';

test('tour visits the largest districts first', () => {
  const districts = [5, 50, 20].map((lines, i) => ({ lines, block: { x: i * 100, y: 0, w: 80, h: 40, node: { name: `d${i}` } } }));
  const stops = tourStops(districts, 2);
  assert.deepEqual(stops.map(stop => stop.district.lines), [50, 20]);
  assert.equal(stops[0].pose.x, 140);
  assert.ok(stops[0].pose.distance >= 120);
});

test('places round-trip through the URL fragment', () => {
  const camera = { view: 'walk', ex: 12.345, ey: 67.891, ez: 1.7, lookYaw: 1.23456, lookPitch: -.1 };
  const hash = encodePlace({ repo: 'https://github.com/prometheus/prometheus', view: 'city', camera, file: 'cmd/prometheus/main.go' });
  const place = decodePlace(hash);
  assert.equal(place.repo, 'https://github.com/prometheus/prometheus');
  assert.equal(place.file, 'cmd/prometheus/main.go');
  assert.deepEqual(place.camera, { view: 'walk', ex: 12.3, ey: 67.9, ez: 1.7, lookYaw: 1.235, lookPitch: -.1 });
  assert.equal(decodePlace(encodePlace({ repo: 'https://github.com/a/b', view: '3d' })).camera, null);
});

test('untrusted fragments are rejected or sanitised', () => {
  assert.equal(decodePlace('#repo=https://evil.example/a/b'), null);
  assert.equal(decodePlace('#repo=javascript:alert(1)'), null);
  const place = decodePlace('#repo=https://github.com/a/b&view=bogus&cam=walk:1,2,NaN,4,5');
  assert.equal(place.view, '2d');
  assert.equal(place.camera, null);
});

test('joystick maps drag to movement with a dead zone and clamp', () => {
  assert.deepEqual(joystick(2, 2), { forward: 0, right: 0 });
  const full = joystick(0, -200);
  assert.ok(Math.abs(full.forward - 1) < 1e-9 && Math.abs(full.right) < 1e-9);
  const half = joystick(28, 0);
  assert.ok(Math.abs(half.right - .5) < 1e-9);
});
