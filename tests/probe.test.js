import test from 'node:test';
import assert from 'node:assert/strict';
import { ProbeSystem } from '../src/physics/probe.js';
import { timeDilation, tidalStretch } from '../src/physics/schwarzschild.js';

const MASSES = [0.5, 1, 2.5];

// Steps in units of M so every mass behaves identically (G = c = 1 scaling).
function run(sys, mass, untilFn, maxSteps = 200000, dtPerM = 0.05) {
  for (let i = 0; i < maxSteps; i++) {
    sys.step(dtPerM * mass, mass);
    if (untilFn()) return i + 1;
  }
  return -1;
}

test('default drop: r = 10 r_s on the camera side, off the disk plane, slightly moving', () => {
  for (const mass of MASSES) {
    const sys = new ProbeSystem();
    const id = sys.drop({}, mass, [0, 0, 30]);
    const p = sys.list[0];
    assert.equal(p.id, id);
    assert.ok(Math.abs(p.r - 20 * mass) < 1e-9, `r=${p.r}`);
    assert.ok(p.position[2] > 0 && Math.abs(p.position[0]) < 1e-9, 'on the +z camera side');
    assert.notEqual(p.position[1], 0, 'slightly off-plane');
    assert.ok(Math.abs(p.position[1]) < 0.2 * p.r);
    const speed = Math.hypot(...p.velocity);
    assert.ok(speed > 0 && speed < 0.3, `speed ${speed}`);
    assert.equal(p.captured, false);
    assert.equal(p.properTime, 0);
    assert.equal(p.coordTime, 0);
  }
});

test('default drop follows the camera position direction', () => {
  const sys = new ProbeSystem();
  sys.drop({}, 1, [30, 10, -30]);
  const p = sys.list[0];
  const camLen = Math.hypot(30, 10, 30);
  const dot = (p.position[0] * 30 + p.position[1] * 10 + p.position[2] * -30) / (p.r * camLen);
  assert.ok(dot > 0.999, `probe is on the camera side (cos=${dot})`);
  assert.ok(Math.abs(p.r - 20) < 1e-9);
  sys.drop({}, 1); // no camera: +z
  assert.ok(sys.list[1].position[2] > 19);
});

test('default drop plunges inward and is captured in ~60–100 proper-time units at M = 1', () => {
  const sys = new ProbeSystem();
  sys.drop({}, 1, [0, 5, 30]);
  const p = sys.list[0];
  let prevR = p.r;
  const steps = run(sys, 1, () => {
    if (!p.captured) {
      assert.ok(p.r < prevR, 'radius decreases monotonically on the plunge');
      prevR = p.r;
    }
    return p.captured;
  });
  assert.ok(steps > 0, 'captured');
  assert.ok(p.properTime > 60 && p.properTime < 100, `captured at proper time ${p.properTime}`);
  assert.ok(p.r <= 2 + 1e-9);
  assert.equal(p.timeDilation, 0);
});

test('capture happens at every mass in the allowed range, with proper time scaling ∝ M', () => {
  const times = MASSES.map((mass) => {
    const sys = new ProbeSystem();
    sys.drop({}, mass, [10, 3, 25]);
    const p = sys.list[0];
    assert.ok(run(sys, mass, () => p.captured) > 0, `mass ${mass} never captured`);
    assert.ok(p.r <= 2 * mass + 1e-9);
    return p.properTime;
  });
  near(times[1] / times[0], 2, 0.02);
  near(times[2] / times[1], 2.5, 0.02);
});

function near(actual, expected, tol) {
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} ≈ ${expected} (±${tol})`);
}

test('radial free fall from rest matches the exact Schwarzschild proper time to the horizon', () => {
  // r = (r0/2)(1 + cos η), τ = sqrt(r0³/8M)(η + sin η); r0 = 20, M = 1 → η = acos(-0.8)
  const eta = Math.acos(-0.8);
  const expected = Math.sqrt(20 ** 3 / 8) * (eta + Math.sin(eta));
  const sys = new ProbeSystem();
  sys.drop({ position: [0, 0, 20], velocity: [0, 0, 0] }, 1);
  const p = sys.list[0];
  run(sys, 1, () => p.captured);
  assert.ok(p.captured);
  near(p.properTime, expected, expected * 0.01);
  assert.ok(p.coordTime > p.properTime, 'distant clocks run ahead of the probe clock');
});

test('coordinate time runs ahead of proper time and keeps increasing', () => {
  const sys = new ProbeSystem();
  sys.drop({}, 1, [0, 5, 30]);
  const p = sys.list[0];
  let lastCoord = 0;
  let lastProper = 0;
  run(sys, 1, () => {
    assert.ok(p.coordTime >= lastCoord);
    assert.ok(p.properTime > lastProper);
    assert.ok(p.coordTime >= p.properTime - 1e-9);
    lastCoord = p.coordTime;
    lastProper = p.properTime;
    return p.captured;
  });
  assert.ok(p.coordTime > 1.2 * p.properTime, 'large dilation by the time it reaches the horizon');
  assert.ok(Number.isFinite(p.coordTime));
});

test('time dilation field follows the true radius until capture', () => {
  const sys = new ProbeSystem();
  sys.drop({}, 1, [0, 5, 30]);
  const p = sys.list[0];
  let checked = 0;
  run(sys, 1, () => {
    if (!p.captured) {
      near(p.timeDilation, timeDilation(p.r, 1), 1e-12);
      checked++;
    }
    return p.captured;
  });
  assert.ok(checked > 100);
});

test('apparent view: stays outside the horizon after capture, creeps toward r_s and freezes', () => {
  for (const mass of MASSES) {
    const rs = 2 * mass;
    const sys = new ProbeSystem();
    sys.drop({}, mass, [0, 5, 30]);
    const p = sys.list[0];
    let captureCheck = false;
    let lastApparentR = p.apparent.r;
    let frozenAt = -1;
    const dt = 0.05 * mass;
    for (let i = 0; i < 200000 && frozenAt < 0; i++) {
      sys.step(dt, mass);
      assert.ok(p.apparent.r > rs, 'apparent probe never reaches the horizon');
      assert.ok(p.apparent.r <= lastApparentR + 1e-9, 'apparent radius never increases on an inward plunge');
      lastApparentR = p.apparent.r;
      if (p.captured && !captureCheck) {
        captureCheck = true;
        assert.ok(p.apparent.r > 2 * rs, 'at the moment the true probe crosses, distant observers still see it well outside');
        assert.ok(!p.apparent.frozen);
        assert.ok(p.apparent.redshift > 0.1);
      }
      if (p.apparent.frozen) frozenAt = i;
    }
    assert.ok(captureCheck && frozenAt > 0, `mass ${mass}: apparent view froze`);
    assert.ok(p.apparent.r - rs < 0.02 * rs);

    // Keep running: it approaches r_s ever more closely but stays outside.
    const before = p.apparent.r - rs;
    for (let i = 0; i < 400; i++) sys.step(dt, mass); // 20 M = 10 e-folds of r_s
    const after = p.apparent.r - rs;
    assert.ok(after > 0 && after < before * 0.1, `gap ${before} → ${after}`);
    assert.ok(p.apparent.frozen);
  }
});

test('apparent redshift (static-observer dτ/dt) tends to ~0, dimming and reddening the probe', () => {
  const sys = new ProbeSystem();
  sys.drop({}, 1, [0, 5, 30]);
  const p = sys.list[0];
  const start = p.apparent.redshift;
  assert.ok(start > 0.9, `starts nearly unshifted (${start})`);
  run(sys, 1, () => p.captured);
  const atCapture = p.apparent.redshift;
  for (let i = 0; i < 1600; i++) sys.step(0.05, 1); // +80 time units
  const late = p.apparent.redshift;
  assert.ok(atCapture < start);
  assert.ok(late < atCapture);
  assert.ok(late < 0.01, `late redshift ${late}`);
  assert.ok(late > 0, 'never exactly zero');
  near(late, timeDilation(p.apparent.r, 1), 1e-12);
});

test('tidalStretch of the apparent probe grows as it nears the horizon', () => {
  const sys = new ProbeSystem();
  sys.drop({}, 1, [0, 5, 30]);
  const p = sys.list[0];
  const initial = p.apparent.stretch;
  assert.equal(initial, 1);
  let prev = initial;
  for (let i = 0; i < 6000; i++) {
    sys.step(0.05, 1);
    assert.ok(p.apparent.stretch >= prev - 1e-12, 'stretch never decreases on the plunge');
    prev = p.apparent.stretch;
  }
  assert.ok(prev > 5, `final stretch ${prev}`);
  assert.ok(prev <= 6);
  near(p.apparent.stretch, tidalStretch(p.apparent.r, 1), 1e-12);
  assert.ok(tidalStretch(5, 1) > tidalStretch(12, 1));
});

test('apparent position is the history at observer time T: it lags the true probe', () => {
  const sys = new ProbeSystem();
  sys.drop({}, 1, [0, 5, 30]);
  const p = sys.list[0];
  for (let i = 0; i < 800; i++) sys.step(0.05, 1); // T = 40, well before capture
  assert.ok(!p.captured);
  assert.ok(p.apparent.r > p.r, 'distant observer sees it higher up than where it really is');
  const dir = (v) => {
    const n = Math.hypot(...v);
    return v.map((c) => c / n);
  };
  const a = dir(p.apparent.position);
  const t = dir(p.position);
  assert.ok(a[0] * t[0] + a[1] * t[1] + a[2] * t[2] > 0.9, 'lagging along (roughly) the same ray');
});

test('probe list: oldest evicted past maxProbes, clear empties it, ids unique', () => {
  const sys = new ProbeSystem(3);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(sys.drop({}, 1));
  assert.equal(new Set(ids).size, 5);
  assert.equal(sys.list.length, 3);
  assert.deepEqual(sys.list.map((p) => p.id), ids.slice(2));
  sys.clear();
  assert.equal(sys.list.length, 0);
  assert.equal(new ProbeSystem().maxProbes, 8);
});

test('explicit position/velocity are honoured; a probe inside the horizon starts captured; bad input throws', () => {
  const sys = new ProbeSystem();
  sys.drop({ position: [0, 0, 12], velocity: [0.1, 0, 0] }, 1);
  const p = sys.list[0];
  assert.deepEqual(p.position, [0, 0, 12]);
  assert.deepEqual(p.velocity, [0.1, 0, 0]);
  sys.drop({ position: [0, 0, 1.5], velocity: [0, 0, 0] }, 1);
  assert.equal(sys.list[1].captured, true);
  assert.throws(() => sys.drop({ position: [0, 0] }, 1), TypeError);
  assert.throws(() => sys.drop({ position: [0, NaN, 1] }, 1), TypeError);
  assert.throws(() => sys.drop({ velocity: 'fast' }, 1), TypeError);
});

test('a stable circular-ish orbit does not fall in and keeps apparent == true position', () => {
  const sys = new ProbeSystem();
  const r0 = 40;
  const v = Math.sqrt(1 / r0) * 0.99; // near-circular at r0 = 40 M
  sys.drop({ position: [r0, 0, 0], velocity: [0, 0, v] }, 1);
  const p = sys.list[0];
  for (let i = 0; i < 4000; i++) sys.step(0.05, 1);
  assert.equal(p.captured, false);
  assert.ok(p.r > 30 && p.r < 41, `r=${p.r}`);
  assert.ok(p.timeDilation > 0.97);
  assert.ok(Math.hypot(...p.position.map((c, i) => c - p.apparent.position[i])) < 8, 'apparent only slightly behind');
});

test('after the history ends the apparent gap r - r_s decays with e-fold time exactly r_s = 2M', () => {
  for (const mass of MASSES) {
    const rs = 2 * mass;
    const sys = new ProbeSystem();
    sys.drop({}, mass, [0, 5, 30]);
    const p = sys.list[0];
    run(sys, mass, () => p.captured);
    // Replay until observer time passes the last recorded coordinate time, then measure.
    run(sys, mass, () => sys.time > p.coordTime + 1e-9);
    const gap0 = p.apparent.r - rs;
    const dt = 0.5 * rs;
    sys.step(dt, mass);
    const gap1 = p.apparent.r - rs;
    near(gap1 / gap0, Math.exp(-dt / rs), 1e-6);
  }
});

test('probe state carries kind and ship half-length bodyRadius = 0.32 M', () => {
  const sys = new ProbeSystem();
  sys.drop({}, 1, [0, 5, 30]);
  assert.equal(sys.list[0].kind, 'probe');
  assert.equal(sys.list[0].bodyRadius, 0.32);
});

test('apparent.velocity is the local static-observer velocity: circular orbit speed sqrt(M/(r-2M)), tangential', () => {
  for (const mass of MASSES) {
    const r = 10 * mass;
    const sys = new ProbeSystem();
    sys.drop({ position: [r, 0, 0], velocity: [0, 0, Math.sqrt(mass / (r - 3 * mass))] }, mass);
    const p = sys.list[0];
    const [vx, vy, vz] = p.apparent.velocity;
    near(Math.hypot(vx, vy, vz), Math.sqrt(mass / (r - 2 * mass)), 1e-9);
    near(vx, 0, 1e-12);
    near(vy, 0, 1e-12);
    assert.ok(vz > 0);
    // Still the same speed (and direction) after a few steps of the stable orbit.
    for (let i = 0; i < 200; i++) sys.step(0.05 * mass, mass);
    const speed = Math.hypot(...p.apparent.velocity);
    near(speed, Math.sqrt(mass / (r - 2 * mass)), 2e-3);
  }
});

test('apparent.velocity of radial infall from rest follows the exact local speed and stays below c', () => {
  const mass = 1;
  const r0 = 20;
  const sys = new ProbeSystem();
  sys.drop({ position: [r0, 0, 0], velocity: [0, 0, 0] }, mass);
  const p = sys.list[0];
  const energy2 = 1 - 2 / r0;
  let checked = 0;
  for (let i = 0; i < 4000 && !p.captured; i++) {
    sys.step(0.05, mass);
    // The apparent state is a point on the worldline: its local speed matches the exact value at apparent.r.
    const f = 1 - 2 / p.apparent.r;
    const expected = Math.sqrt(Math.max(0, 1 - f / energy2));
    const speed = Math.hypot(...p.apparent.velocity);
    assert.ok(speed < 1);
    near(speed, expected, 5e-3);
    if (p.apparent.r < r0 - 0.5) assert.ok(p.apparent.velocity[0] < 0, 'moving inward');
    checked++;
  }
  assert.ok(checked > 100);
  // Whatever the observer sees, the local speed never reaches c, even after capture.
  for (let i = 0; i < 400; i++) {
    sys.step(0.5, mass);
    assert.ok(Math.hypot(...p.apparent.velocity) < 1);
  }
  assert.ok(Math.hypot(...p.apparent.velocity) > 0.9, 'frozen probe is moving at nearly c locally');
});
