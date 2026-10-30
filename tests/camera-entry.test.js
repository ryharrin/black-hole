import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { CameraRig } from '../src/camera/rig.js';
import { cinematicPose, nearestCinematicPhase, EINSTEIN_TIME } from '../src/camera/cinematic.js';

const target = { addEventListener() {}, removeEventListener() {} };
const dom = { ...target, style: {}, setPointerCapture() {}, releasePointerCapture() {}, ownerDocument: { ...target } };

const unit = (p) => {
  const inc = (p.inclinationDeg * Math.PI) / 180;
  const az = (p.azimuthDeg * Math.PI) / 180;
  return [Math.sin(inc) * Math.sin(az), Math.cos(inc), Math.sin(inc) * Math.cos(az)];
};
// Great-circle angle (deg) between two view directions (az deg is not an angle near the poles).
const stepDeg = (a, b) => {
  const u = unit(a);
  const v = unit(b);
  const dot = Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  return (Math.acos(dot) * 180) / Math.PI;
};

function makeRig(pose) {
  const rig = new CameraRig(new PerspectiveCamera(50, 1, 0.1, 200), dom);
  rig.setPose(pose);
  return rig;
}

test('nearest phase of the default view is the Einstein alignment', () => {
  const t = nearestCinematicPhase({ distance: 30, inclinationDeg: 80, azimuthDeg: 0 }, 1);
  assert.ok(Math.abs(t - EINSTEIN_TIME) <= 0.5, `phase ${t}`);
});

test('nearest phase scales with mass', () => {
  const p = cinematicPose(12.3, 2.2);
  const t = nearestCinematicPhase(p, 2.2);
  assert.ok(Math.abs(t - 12.25) <= 0.5, `phase ${t}`);
});

for (const start of [
  { distance: 30, inclinationDeg: 80, azimuthDeg: 0 },
  { distance: 12, inclinationDeg: 40, azimuthDeg: 250 },
  { distance: 70, inclinationDeg: 110, azimuthDeg: 100 },
  { distance: 3, inclinationDeg: 5, azimuthDeg: 333 },
]) {
  test(`entry from ${JSON.stringify(start)} is slow and smooth`, () => {
    const rig = makeRig(start);
    rig.setCinematic(true);
    let prev = rig.getPose();
    assert.ok(stepDeg(start, prev) < 1e-3, 'starts at the current pose');
    let maxStep = 0;
    let firstSeconds = 0;
    for (let i = 0; i < 60 * 12; i++) {
      rig.update(1 / 60, 1);
      const p = rig.getPose();
      const s = stepDeg(prev, p);
      maxStep = Math.max(maxStep, s);
      if (i < 60) firstSeconds += s;
      prev = p;
    }
    assert.ok(maxStep < 1, `max step ${maxStep}`);
    assert.ok(firstSeconds < 15, `first second travelled ${firstSeconds} deg`);
    // After the blend the camera sits on the path.
    const end = cinematicPose(rig.cinematicTime, 1);
    assert.ok(stepDeg(end, prev) < 0.5);
    assert.ok(Math.abs(Math.log(end.distance / rig.getPose().distance)) < 1e-6);
  });
}

test('exit leaves the camera where it is and re-enables controls', () => {
  const rig = makeRig({ distance: 30, inclinationDeg: 80, azimuthDeg: 0 });
  rig.setCinematic(true);
  for (let i = 0; i < 600; i++) rig.update(1 / 60, 1);
  const before = rig.getPose();
  rig.setCinematic(false);
  const after = rig.getPose();
  assert.ok(stepDeg(before, after) < 1e-3);
  assert.ok(Math.abs(before.distance - after.distance) < 1e-6);
  assert.equal(rig.controls.enabled, true);
});
