import test from 'node:test';
import assert from 'node:assert/strict';
import {
  schwarzschildRadius,
  schwarzschildRadiusKm,
  timeDilation,
  keplerBeta,
  lorentzFactor,
  dopplerFactor,
  diskRedshift,
  beamedIntensity,
  iscoRadius,
  photonSphereRadius,
  shadowRadius,
  einsteinAngle,
  tidalStretch,
  starStretchFactor,
  blackbodyColor,
} from '../src/physics/schwarzschild.js';

const near = (actual, expected, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} ≈ ${expected} (±${tol})`);

test('Schwarzschild radius is 2M in geometric units and scales linearly', () => {
  assert.equal(schwarzschildRadius(1), 2);
  assert.equal(schwarzschildRadius(2.5), 5);
  near(schwarzschildRadius(0.5) * 4, schwarzschildRadius(2));
});

test('Schwarzschild radius in km: 2.95 km per solar mass, ~1.27e7 km for Sgr A*', () => {
  near(schwarzschildRadiusKm(1), 2.95325, 1e-12);
  const sgrA = schwarzschildRadiusKm(4.3e6);
  assert.ok(sgrA > 1.26e7 && sgrA < 1.28e7, `Sgr A* r_s = ${sgrA}`);
  near(schwarzschildRadiusKm(20) / schwarzschildRadiusKm(10), 2);
});

test('time dilation: → 1 far away, sqrt(1/2) at r = 4M, 0 at and inside the horizon', () => {
  near(timeDilation(1e12, 1), 1, 1e-9);
  near(timeDilation(4, 1), Math.sqrt(0.5));
  near(timeDilation(8, 2), Math.sqrt(0.5)); // depends only on r/M
  assert.equal(timeDilation(2, 1), 0);
  assert.equal(timeDilation(1.5, 1), 0);
  assert.equal(timeDilation(0, 1), 0);
});

test('time dilation increases monotonically with radius', () => {
  let prev = 0;
  for (let r = 2.0001; r < 200; r *= 1.07) {
    const td = timeDilation(r, 1);
    assert.ok(td > prev, `not increasing at r=${r}`);
    assert.ok(td < 1);
    prev = td;
  }
});

test('keplerBeta follows sqrt(M/(r-2M)), capped at 0.999, and saturates inside the photon sphere', () => {
  near(keplerBeta(6, 1), Math.sqrt(1 / 4));
  near(keplerBeta(10, 2), Math.sqrt(2 / 6));
  assert.equal(keplerBeta(3, 1), 0.999);
  assert.equal(keplerBeta(2.5, 1), 0.999);
  assert.ok(keplerBeta(100, 1) < keplerBeta(10, 1));
  assert.ok(keplerBeta(1000, 1) < 0.999);
});

test('Lorentz factor', () => {
  assert.equal(lorentzFactor(0), 1);
  near(lorentzFactor(0.6), 1.25);
  assert.ok(lorentzFactor(0.999) > 22);
});

test('Doppler factor: 1 at rest, sqrt((1+β)/(1-β)) head-on, inverse receding, 1/γ transverse', () => {
  for (const c of [-1, -0.3, 0, 0.7, 1]) near(dopplerFactor(0, c), 1);
  for (const beta of [0.1, 0.5, 0.9]) {
    const approach = dopplerFactor(beta, 1);
    const recede = dopplerFactor(beta, -1);
    near(approach, Math.sqrt((1 + beta) / (1 - beta)));
    near(recede, Math.sqrt((1 - beta) / (1 + beta)));
    near(approach * recede, 1);
    near(dopplerFactor(beta, 0), 1 / lorentzFactor(beta));
    assert.ok(approach > 1 && recede < 1);
  }
});

test('diskRedshift = gravitational × Doppler, so receding gas is dimmer/redder and approaching gas gets boosted', () => {
  const M = 1;
  const r = 6;
  const beta = keplerBeta(r, M);
  near(diskRedshift(r, M, beta, 0.4), timeDilation(r, M) * dopplerFactor(beta, 0.4));
  near(diskRedshift(r, M, 0, 0), timeDilation(r, M)); // no motion: purely gravitational
  assert.ok(diskRedshift(r, M, beta, 1) > diskRedshift(r, M, beta, 0));
  assert.ok(diskRedshift(r, M, beta, -1) < diskRedshift(r, M, beta, 0));
  assert.ok(diskRedshift(r, M, beta, -1) < 1); // receding side is always redshifted
  assert.equal(diskRedshift(2, M, beta, 1), 0); // nothing escapes the horizon
});

test('beamedIntensity is g^4 by default and g^n otherwise', () => {
  near(beamedIntensity(2), 16);
  near(beamedIntensity(0.5), 0.0625);
  near(beamedIntensity(2, 3), 8);
  assert.equal(beamedIntensity(1), 1);
  assert.ok(beamedIntensity(1.2) > beamedIntensity(1) && beamedIntensity(0.8) < beamedIntensity(1));
});

test('ISCO: 6M at zero spin, ~2.32M at a = 0.9, → M at extremal spin, scaling with mass', () => {
  near(iscoRadius(1, 0), 6, 1e-9);
  near(iscoRadius(2.5, 0), 15, 1e-9);
  near(iscoRadius(1, 0.9), 2.32, 0.01);
  near(iscoRadius(1, 1), 1, 1e-6);
  near(iscoRadius(2, 0.9), 2 * iscoRadius(1, 0.9), 1e-9);
});

test('ISCO decreases monotonically with spin and stays outside the horizon', () => {
  let prev = Infinity;
  for (let a = 0; a <= 0.99; a += 0.01) {
    const r = iscoRadius(1, a);
    assert.ok(r < prev, `not decreasing at a=${a}`);
    assert.ok(r > 1);
    prev = r;
  }
});

test('photon sphere, shadow radius and Einstein angle', () => {
  assert.equal(photonSphereRadius(1), 3);
  near(photonSphereRadius(2), 6);
  near(shadowRadius(1), Math.sqrt(27));
  near(shadowRadius(1), 5.196152422706632, 1e-12);
  assert.ok(shadowRadius(1) > photonSphereRadius(1)); // shadow is larger than the photon sphere
  near(einsteinAngle(1, 100), Math.sqrt(4 / 100));
  near(einsteinAngle(4, 100), 2 * einsteinAngle(1, 100));
  assert.ok(einsteinAngle(1, 400) < einsteinAngle(1, 100));
  // Sgr A* (4.3e6 M_sun) seen from 8.2 kpc: θ_E = sqrt(4GM/(c² D)) ≈ 1e-5 rad ≈ 2 arcsec.
  const massKm = schwarzschildRadiusKm(4.3e6) / 2; // GM/c² = r_s/2
  const distanceKm = 8.2e3 * 3.0857e13; // 8.2 kpc
  const arcsec = einsteinAngle(massKm, distanceKm) * (180 / Math.PI) * 3600;
  assert.ok(arcsec > 1.8 && arcsec < 2.4, `θ_E = ${arcsec} arcsec`);
});

test('tidalStretch: ~1 far away, increases inward, capped at 6', () => {
  assert.equal(tidalStretch(100, 1), 1);
  assert.equal(tidalStretch(15, 1), 1);
  let prev = 1;
  for (let r = 15; r >= 2; r -= 0.25) {
    const s = tidalStretch(r, 1);
    assert.ok(s >= prev, `not monotonic at r=${r}`);
    assert.ok(s <= 6);
    prev = s;
  }
  assert.ok(tidalStretch(3, 1) > tidalStretch(10, 1));
  assert.equal(tidalStretch(2, 1), 6);
  assert.equal(tidalStretch(0.5, 1), 6);
  near(tidalStretch(20, 2), tidalStretch(10, 1)); // depends only on r/M
});

test('starStretchFactor: ≥ 1, grows near the horizon and with radial speed, capped at 8', () => {
  assert.ok(starStretchFactor(1000, 1, 0) >= 1);
  near(starStretchFactor(1e6, 1, 0), 1, 1e-5);
  assert.ok(starStretchFactor(3, 1, 0) > starStretchFactor(30, 1, 0));
  near(starStretchFactor(4, 1, 0), Math.SQRT2);
  assert.ok(starStretchFactor(30, 1, -0.3) > starStretchFactor(30, 1, 0));
  near(starStretchFactor(30, 1, 0.3), starStretchFactor(30, 1, -0.3)); // |β|
  assert.equal(starStretchFactor(2.0001, 1, 0.9), 8);
  assert.equal(starStretchFactor(1.5, 1, 0), 8);
});

test('blackbodyColor: normalized linear RGB, cool = red, hot = blue', () => {
  for (const T of [1000, 2500, 4500, 6500, 12000, 30000, 100000]) {
    const c = blackbodyColor(T);
    assert.equal(c.length, 3);
    assert.equal(Math.max(...c), 1);
    for (const v of c) assert.ok(v >= 0 && v <= 1, `T=${T} component ${v}`);
  }
  const cool = blackbodyColor(2500);
  const hot = blackbodyColor(30000);
  assert.ok(cool[0] > cool[2] * 3, 'cool blackbody should be much redder than blue');
  assert.ok(hot[2] > hot[0], 'hot blackbody should be bluer than red');
  assert.ok(blackbodyColor(6500)[2] / blackbodyColor(6500)[0] > cool[2] / cool[0]);
});
