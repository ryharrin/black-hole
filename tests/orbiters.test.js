import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ORBITERS, OrbiterSystem } from '../src/physics/orbiters.js';
import {
  decayCoefficient,
  keplerBeta,
  orbitalPeriod,
  petersInspiralTime,
  radiationReactionAccel,
} from '../src/physics/schwarzschild.js';
import { DEFAULT_SETTINGS } from '../src/physics/presets.js';

const REAL_SECONDS = 24; // scene-time units per real second at timeScale 1 and mass 1 (see src/main.js)
const CIRCULAR = { eccentricity: 0, inclinationDeg: 0, phase: 0, seed: 1 };

const near = (actual, expected, tol) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} ≈ ${expected} (±${tol})`);

function settings(extra = {}) {
  return { ...DEFAULT_SETTINGS, ...extra };
}

/** Steps `sys` until `stop()` is true or `maxTime` of simulated time passes; returns elapsed sim time. */
function run(sys, mass, q, dt, stop, maxTime) {
  let t = 0;
  while (t < maxTime && !stop()) {
    sys.step(dt, mass, q);
    t += dt;
  }
  return t;
}

function single(opts, mass = 1, extraSettings = {}) {
  const sys = new OrbiterSystem();
  sys.add(opts, mass, settings(extraSettings));
  return { sys, o: sys.list[0] };
}

// ---- schwarzschild.js decay helpers ----

test('decayCoefficient: 0 at 0, non-negative and strictly increasing on [0, 1]', () => {
  assert.equal(decayCoefficient(0), 0);
  assert.equal(decayCoefficient(-1), 0);
  assert.equal(decayCoefficient(NaN), 0);
  let prev = 0;
  for (let x = 0.01; x <= 1.0001; x += 0.01) {
    const q = decayCoefficient(x);
    assert.ok(q > prev, `q(${x}) = ${q} must exceed ${prev}`);
    prev = q;
  }
});

test('petersInspiralTime = 5 r⁴ / (256 q M³), Infinity without decay, scales as M for r ∝ M', () => {
  near(petersInspiralTime(10, 1, 0.5) / ((5 * 10 ** 4) / (256 * 0.5)), 1, 1e-12);
  assert.equal(petersInspiralTime(10, 1, 0), Infinity);
  near(petersInspiralTime(20, 2, 0.3) / petersInspiralTime(10, 1, 0.3), 2, 1e-12);
  assert.ok(petersInspiralTime(8, 1, 1) < petersInspiralTime(16, 1, 1));
});

test('orbitalPeriod = 2π sqrt(r³/M)', () => {
  near(orbitalPeriod(10, 1), 2 * Math.PI * Math.sqrt(1000), 1e-9);
  near(orbitalPeriod(20, 2) / orbitalPeriod(10, 1), Math.sqrt(8 / 2), 1e-12);
});

test('radiationReactionAccel opposes velocity and removes specific energy at the Peters rate', () => {
  for (const mass of [0.5, 1, 2.5]) {
    const r = 12 * mass;
    const v = Math.sqrt(mass / (r - 3 * mass));
    const q = 0.2;
    const a = radiationReactionAccel([r, 0, 0], [0, 0.3 * v, 0.9 * v], mass, q);
    const speed = Math.hypot(0, 0.3 * v, 0.9 * v);
    // antiparallel to v
    near((a[1] * 0.3 * v + a[2] * 0.9 * v) / (Math.hypot(...a) * speed), -1, 1e-12);
    near(a[0], 0, 1e-15);
    // dE/dt = a · v = -(32/5) q M⁴ / r⁵ (Peters circular rate, dimensionally consistent)
    near((a[1] * 0.3 * v + a[2] * 0.9 * v) / (-(32 / 5) * q * mass ** 4 / r ** 5), 1, 1e-12);
  }
  assert.deepEqual(radiationReactionAccel([10, 0, 0], [0, 0.3, 0], 1, 0).map((c) => Math.abs(c)), [0, 0, 0]);
});

// ---- OrbiterSystem ----

test('q = 0: a circular orbit at r = 10M keeps its radius within 1% over 20 orbits', () => {
  for (const mass of [1, 2]) {
    const r0 = 10 * mass;
    const { sys, o } = single({ ...CIRCULAR, radius: r0 }, mass, { orbitDecay: 0 });
    let min = Infinity;
    let max = 0;
    run(
      sys,
      mass,
      0,
      0.1 * mass,
      () => {
        min = Math.min(min, o.r);
        max = Math.max(max, o.r);
        return o.orbits >= 20;
      },
      1e6,
    );
    assert.ok(o.orbits >= 20, 'completed 20 orbits');
    assert.ok(max / r0 < 1.01 && min / r0 > 0.99, `radius range [${min / r0}, ${max / r0}] r0`);
    assert.equal(o.status, 'orbiting');
    assert.ok(!o.captured);
    assert.equal(o.inspiralTime, Infinity);
  }
});

test('q = 0: default random eccentricity (≤ 0.08) keeps the orbit bound and bounded in radius', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { sys, o } = single({ seed, radius: 14 }, 1, { orbitDecay: 0 });
    let min = Infinity;
    let max = 0;
    run(sys, 1, 0, 0.2, () => ((min = Math.min(min, o.r)), (max = Math.max(max, o.r)), o.orbits >= 10), 1e6);
    assert.ok(min > 14 * 0.8 && max < 14 * 1.12, `seed ${seed}: r in [${min}, ${max}]`);
  }
});

test('q > 0: the radius shrinks orbit over orbit and the body is eventually captured and freezes like a probe', () => {
  const q = 0.05;
  const { sys, o } = single({ ...CIRCULAR, radius: 14 });
  const rAtOrbit = [];
  let counted = 0;
  run(
    sys,
    1,
    q,
    0.2,
    () => {
      if (Math.floor(o.orbits) > counted) {
        counted = Math.floor(o.orbits);
        rAtOrbit.push(o.r);
      }
      return o.captured;
    },
    1e6,
  );
  assert.ok(o.captured, 'captured');
  assert.ok(rAtOrbit.length >= 5, `completed ${rAtOrbit.length} orbits before capture`);
  for (let i = 1; i < rAtOrbit.length; i++) assert.ok(rAtOrbit[i] < rAtOrbit[i - 1], `orbit ${i}: ${rAtOrbit[i]} < ${rAtOrbit[i - 1]}`);
  assert.equal(o.status, 'captured');
  assert.equal(o.inspiralTime, 0);
  assert.equal(o.r, 2);

  // Distant observer: still outside the horizon, creeping inward, redshift → 0, eventually frozen.
  assert.ok(o.apparent.r > 2);
  assert.ok(sys.time > 0);
  let prevR = Infinity;
  for (let i = 0; i < 400000 && !o.apparent.frozen; i++) {
    sys.step(1, 1, q);
    assert.ok(o.apparent.r > 2, 'apparent never reaches the horizon');
    assert.ok(o.apparent.r <= prevR + 1e-9, 'apparent radius is non-increasing after capture');
    prevR = Math.min(prevR, o.apparent.r);
  }
  assert.ok(o.apparent.frozen, 'apparent view freezes at the horizon');
  assert.ok(o.apparent.redshift < 0.15);
  assert.ok(o.apparent.stretch > 4);
  const speed = Math.hypot(...o.apparent.velocity);
  assert.ok(speed > 0.9 && speed < 1, `frozen body is nearly c locally (${speed})`);
});

test('status runs orbiting → inspiral → plunging → captured and inspiralTime tracks the Peters time', () => {
  const q = decayCoefficient(0.2);
  const { sys, o } = single({ ...CIRCULAR, radius: 14 }, 1, { orbitDecay: 0.2 });
  const seen = [o.status];
  assert.equal(o.status, 'orbiting');
  near(o.inspiralTime / petersInspiralTime(o.r, 1, q), 1, 1e-9);
  let prevTime = o.inspiralTime;
  let decreases = 0;
  run(
    sys,
    1,
    q,
    0.2,
    () => {
      if (o.status !== seen[seen.length - 1]) seen.push(o.status);
      if (o.inspiralTime < prevTime) decreases++;
      if (!o.captured) near(o.inspiralTime / petersInspiralTime(o.r, 1, q), 1, 1e-9);
      prevTime = o.inspiralTime;
      return o.captured;
    },
    1e6,
  );
  assert.deepEqual(seen, ['orbiting', 'inspiral', 'plunging', 'captured']);
  assert.ok(decreases > 100);
  assert.ok(o.status === 'captured');
});

test('da/dt follows the Peters r⁻³ scaling: rate(16M)/rate(12M) ≈ (12/16)³ within 15%', () => {
  const q = 0.02;
  function rate(r0) {
    const { sys, o } = single({ ...CIRCULAR, radius: r0 });
    const period = orbitalPeriod(r0, 1);
    run(sys, 1, q, 0.05, () => false, 0.5 * period); // settle
    const r1 = o.r;
    const c1 = o.coordTime;
    run(sys, 1, q, 0.05, () => false, period); // measure over one orbit
    return (o.r - r1) / (o.coordTime - c1);
  }
  const a16 = rate(16);
  const a12 = rate(12);
  assert.ok(a16 < 0 && a12 < 0);
  const expected = (12 / 16) ** 3;
  assert.ok(Math.abs(a16 / a12 / expected - 1) < 0.15, `ratio ${a16 / a12} vs ${expected}`);
  // And the absolute rate is the Peters value (coordinate time) within 20%.
  near(a16 / (-(64 / 5) * q / 16 ** 3), 1, 0.2);
});

test('merge time from r = 14M is within 30% of the Peters inspiral time (small q)', () => {
  const q = 0.05;
  const { sys, o } = single({ ...CIRCULAR, radius: 14 });
  let coordAtIsco = null;
  const sceneTime = run(sys, 1, q, 0.2, () => {
    if (coordAtIsco === null && o.r < 6) coordAtIsco = o.coordTime;
    return o.captured;
  }, 1e6);
  assert.ok(o.captured);
  // Total scene time to reach the horizon vs 5 a⁴/(256 q M³)
  const peters = petersInspiralTime(14, 1, q);
  assert.ok(Math.abs(sceneTime / peters - 1) < 0.3, `scene time ${sceneTime} vs Peters ${peters}`);
  // Distant-observer time to the ISCO vs the Peters time between 14M and 6M (the ISCO takes over after that).
  const petersToIsco = (5 * (14 ** 4 - 6 ** 4)) / (256 * q);
  assert.ok(Math.abs(coordAtIsco / petersToIsco - 1) < 0.3, `coordinate time to ISCO ${coordAtIsco} vs ${petersToIsco}`);
});

test('plunge ends in capture even at strong radiation reaction (no hovering inside the ISCO)', () => {
  for (const decay of [0.7, 1]) {
    for (let seed = 1; seed <= 5; seed++) {
      const q = decayCoefficient(decay);
      const { sys, o } = single({ seed, radius: 14 });
      const t = run(sys, 1, q, 24 / 60, () => o.captured, 24 * 60);
      assert.ok(o.captured, `decay ${decay} seed ${seed} not captured in 60 s`);
      assert.ok(t < 24 * 20, `decay ${decay} seed ${seed} took ${t / 24} s`);
    }
  }
});

test('real-time tuning (scene time = real seconds × 24): default decay captures in 40–90 s after ≥ 3 orbits', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const q = decayCoefficient(DEFAULT_SETTINGS.orbitDecay);
    const { sys, o } = single({ seed, radius: 14 });
    const t = run(sys, 1, q, REAL_SECONDS / 60, () => o.captured, 200 * REAL_SECONDS);
    assert.ok(o.captured, `seed ${seed}`);
    assert.ok(t >= 40 * REAL_SECONDS && t <= 90 * REAL_SECONDS, `seed ${seed}: captured after ${t / REAL_SECONDS} s`);
    assert.ok(o.orbits >= 3, `seed ${seed}: ${o.orbits} orbits`);
  }
});

test('real-time tuning: orbitDecay 1 captures within 15 s; 0.05 survives 5 minutes; 0 holds radius within 1% for 20 orbits', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const q = decayCoefficient(1);
    const { sys, o } = single({ seed, radius: 14 });
    const t = run(sys, 1, q, REAL_SECONDS / 60, () => o.captured, 100 * REAL_SECONDS);
    assert.ok(o.captured && t <= 15 * REAL_SECONDS, `seed ${seed}: ${t / REAL_SECONDS} s`);
  }
  {
    const { sys, o } = single({ seed: 2, radius: 14 });
    const t = run(sys, 1, decayCoefficient(0.05), REAL_SECONDS / 30, () => o.captured, 300 * REAL_SECONDS);
    assert.ok(!o.captured && t >= 300 * REAL_SECONDS, 'still orbiting after 5 minutes');
  }
  {
    const { sys, o } = single({ ...CIRCULAR, radius: 14 }, 1, { orbitDecay: 0 });
    let max = 0;
    let min = Infinity;
    run(sys, 1, decayCoefficient(0), REAL_SECONDS / 60, () => ((max = Math.max(max, o.r)), (min = Math.min(min, o.r)), o.orbits >= 20), 1e6);
    assert.ok(o.orbits >= 20 && max < 14 * 1.01 && min > 14 * 0.99);
  }
});

test('decay scales with mass: the same relative orbit takes ∝ M to be captured', () => {
  const q = 0.3;
  const times = [1, 2].map((mass) => {
    const { sys, o } = single({ ...CIRCULAR, radius: 14 * mass }, mass);
    return run(sys, mass, q, 0.1 * mass, () => o.captured, 1e6);
  });
  near(times[1] / times[0], 2, 0.1);
});

test('seeded determinism: same seed → same kind, style, temperature, bodyRadius and orbit; ranges per kind', () => {
  const a = new OrbiterSystem();
  const b = new OrbiterSystem();
  for (const kind of ['star', 'planet']) {
    for (let seed = 1; seed <= 40; seed++) {
      const ida = a.add({ kind, seed }, 1, settings());
      const idb = b.add({ kind, seed }, 1, settings());
      const sa = a.list.find((s) => s.id === ida);
      const sb = b.list.find((s) => s.id === idb);
      for (const key of ['kind', 'style', 'temperature', 'bodyRadius', 'seed']) assert.equal(sa[key], sb[key], key);
      assert.deepEqual(sa.position, sb.position);
      assert.deepEqual(sa.velocity, sb.velocity);
      if (kind === 'star') {
        assert.equal(sa.style, 'star');
        assert.ok(sa.bodyRadius >= 0.42 && sa.bodyRadius <= 0.6);
        assert.ok(sa.temperature >= 2800 && sa.temperature <= 22000);
      } else {
        assert.ok(['gas', 'rocky', 'ice'].includes(sa.style));
        assert.ok(sa.bodyRadius >= 0.22 && sa.bodyRadius <= 0.34);
        assert.equal(sa.temperature, 0);
      }
    }
  }
  const sys = new OrbiterSystem(100);
  for (let seed = 1; seed <= 300; seed++) sys.add({ kind: 'planet', seed }, 1, settings());
  assert.deepEqual(new Set(sys.list.map((s) => s.style)), new Set(['gas', 'rocky', 'ice']));
  const temps = [];
  for (let seed = 1; seed <= 300; seed++) {
    sys.clear();
    sys.add({ kind: 'star', seed }, 1, settings());
    temps.push(sys.list[0].temperature);
  }
  assert.ok(Math.min(...temps) < 4500 && Math.max(...temps) > 12000, 'temperatures span red dwarf to blue');
  // Different seeds differ; the default kind is 'star'; an unseeded add still gets an integer seed.
  const x = new OrbiterSystem();
  x.add({ seed: 1 }, 1, settings());
  x.add({ seed: 2 }, 1, settings());
  assert.notEqual(x.list[0].temperature, x.list[1].temperature);
  assert.equal(x.list[0].kind, 'star');
  x.add({}, 1, settings());
  assert.ok(Number.isInteger(x.list[2].seed));
});

test('list: oldest evicted beyond MAX_ORBITERS, ids unique and increasing, clear empties it', () => {
  assert.equal(MAX_ORBITERS, 8);
  const sys = new OrbiterSystem();
  const ids = [];
  for (let i = 0; i < MAX_ORBITERS + 3; i++) ids.push(sys.add({ seed: i + 1 }, 1, settings()));
  assert.equal(sys.list.length, MAX_ORBITERS);
  assert.deepEqual(sys.list.map((s) => s.id), ids.slice(3));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]));
  sys.step(1, 1, 0.1); // stepping evicted bodies' neighbours still works
  sys.clear();
  assert.equal(sys.list.length, 0);
  const small = new OrbiterSystem(2);
  for (let i = 0; i < 5; i++) small.add({ seed: i }, 1, settings());
  assert.equal(small.list.length, 2);
});

test('spawn: prograde orbit whose angular momentum follows diskTilt (disk normal = +y rotated about x)', () => {
  const unit = (v) => v.map((c) => c / Math.hypot(...v));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const tilt of [-30, -10, 0, 20, 30]) {
    const t = (tilt * Math.PI) / 180;
    const normal = [0, Math.cos(t), Math.sin(t)];
    // No inclination: exactly in the disk plane.
    for (const phase of [0, 1.3, 4]) {
      const { o } = single({ seed: 5, phase, inclinationDeg: 0, radius: 14 }, 1, { diskTilt: tilt });
      const L = unit(cross(o.position, o.velocity));
      near(dot(L, normal), 1, 1e-12);
      near(o.r, 14 * (1 + 0), 14 * 0.09);
    }
    // Default random inclination (±12°): angular momentum stays within 12° of the disk normal, prograde.
    for (let seed = 1; seed <= 20; seed++) {
      const { o } = single({ seed }, 1, { diskTilt: tilt });
      const L = unit(cross(o.position, o.velocity));
      const angle = (Math.acos(Math.min(1, dot(L, normal))) * 180) / Math.PI;
      assert.ok(angle <= 12 + 1e-6, `tilt ${tilt} seed ${seed}: ${angle}°`);
    }
  }
  // After stepping, the counter-clockwise (about the disk normal) motion accumulates positive orbits.
  const { sys, o } = single({ ...CIRCULAR, radius: 14 }, 1, { diskTilt: 20 });
  sys.step(100, 1, 0);
  assert.ok(o.orbits > 0.25 && o.orbits < 0.35, `orbits ${o.orbits}`);
});

test('spawn: radius defaults to settings.orbitRadius · M (semi-major axis), explicit radius wins', () => {
  const { o: a } = single({ ...CIRCULAR }, 1, { orbitRadius: 20 });
  near(a.r, 20, 1e-9);
  const { o: b } = single({ ...CIRCULAR }, 2, { orbitRadius: 20 });
  near(b.r, 40, 1e-9);
  const { o: c } = single({ ...CIRCULAR, radius: 11 }, 1, { orbitRadius: 20 });
  near(c.r, 11, 1e-9);
});

test('orbiter apparent.velocity is the local circular speed sqrt(M/(r-2M)) at q = 0', () => {
  const { o } = single({ ...CIRCULAR, radius: 10 }, 1, { orbitDecay: 0 });
  near(Math.hypot(...o.apparent.velocity), keplerBeta(10, 1), 1e-9);
});

test('step ignores a bad dt and advances the observer clock by dtSim', () => {
  const { sys, o } = single({ ...CIRCULAR, radius: 14 });
  const before = [...o.position];
  sys.step(-5, 1, 0.1);
  sys.step(NaN, 1, 0.1);
  assert.deepEqual(o.position, before);
  sys.step(2, 1, 0.1);
  near(sys.time, 2, 1e-12);
  assert.ok(o.properTime > 1.99 && o.properTime < 2.01);
  assert.ok(o.coordTime > o.properTime);
});
