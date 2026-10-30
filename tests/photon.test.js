import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photonReleasePoint } from '../src/physics/photon.js';

const base = {
  origin: [0, 0, 30],
  forward: [0, 0, -1],
  bend: 0,
  spin: 0,
  diskAxis: [0, 1, 0],
  disk: false,
  innerRadius: 6,
  minRadius: 6,
};
const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const close = (a, b, tol, msg) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < tol, `${msg}: ${a} vs ${b}`));

test('straight ray releases on the plane through the hole facing the camera', () => {
  const point = photonReleasePoint({ ...base, direction: unit([0.3, 0.2, -1]) });
  close(point, [9, 6, 0], 1e-9, 'release point');
});

test('ray hitting the near disk releases in front of the disk, on the same ray', () => {
  const origin = [0, 6, 30];
  const direction = unit([0, -6, -16]); // reaches y = 0 at z = 14, inside the disk
  const point = photonReleasePoint({ ...base, origin, direction, disk: true });
  const hit = [0, 0, 14];
  const toCamera = unit(origin.map((x, i) => x - hit[i]));
  close(point, hit.map((x, i) => x + 0.8 * toCamera[i]), 1e-9, 'release point');
});

test('ray aimed at the shadow releases at the radius floor instead of inside the horizon', () => {
  const point = photonReleasePoint({ ...base, bend: 1, direction: [0, 0, -1], minRadius: 6 });
  close(point, [0, 0, 6], 1e-6, 'release point');
});

test('lensing bends the release point toward the hole compared with a straight ray', () => {
  const direction = unit([0.18, 0, -1]); // impact parameter ~5.3 M: strongly bent
  const straight = photonReleasePoint({ ...base, direction });
  const bent = photonReleasePoint({ ...base, bend: 1, direction, minRadius: 3 });
  assert.ok(Math.abs(bent[2]) < 1e-6, 'bent ray still releases on the hole plane');
  assert.ok(bent[0] < straight[0] - 0.5, `bent x ${bent[0]} should sit well inside straight x ${straight[0]}`);
});
