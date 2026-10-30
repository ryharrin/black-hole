import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAM_RANGES,
  DEFAULT_SETTINGS,
  PRESETS,
  applyPreset,
  clampSettings,
  createDefaultSettings,
} from '../src/physics/presets.js';

const RANGED = ['mass', 'spin', 'diskTemp', 'diskTilt', 'lensingStrength', 'timeScale'];

test('all three presets exist with their exact labels', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ['gargantua', 'quiet', 'sgrA']);
  assert.equal(PRESETS.gargantua.label, 'Gargantua');
  assert.equal(PRESETS.sgrA.label, 'Sagittarius A*');
  assert.equal(PRESETS.quiet.label, 'Quiet');
  for (const [id, p] of Object.entries(PRESETS)) {
    assert.equal(p.id, id);
    assert.ok(p.description.length > 0);
    assert.ok(p.massSolarPerUnit > 0);
  }
});

test('every preset value is within PARAM_RANGES and covers every ranged parameter', () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    for (const key of RANGED) {
      const v = preset.settings[key];
      const { min, max } = PARAM_RANGES[key];
      assert.ok(Number.isFinite(v), `${id}.${key} missing`);
      assert.ok(v >= min && v <= max, `${id}.${key}=${v} outside [${min}, ${max}]`);
    }
  }
});

test('PARAM_RANGES are well-formed and defaults agree with DEFAULT_SETTINGS', () => {
  for (const key of RANGED) {
    const r = PARAM_RANGES[key];
    assert.ok(r.min < r.max && r.step > 0, key);
    assert.ok(r.default >= r.min && r.default <= r.max, key);
    assert.ok(r.label && typeof r.unit === 'string', key);
    assert.equal(DEFAULT_SETTINGS[key], r.default);
  }
  assert.deepEqual([PARAM_RANGES.mass.min, PARAM_RANGES.mass.max], [0.5, 2.5]);
  assert.deepEqual([PARAM_RANGES.spin.min, PARAM_RANGES.spin.max], [0, 0.99]);
  assert.deepEqual([PARAM_RANGES.diskTemp.min, PARAM_RANGES.diskTemp.max], [2500, 30000]);
  assert.deepEqual([PARAM_RANGES.diskTilt.min, PARAM_RANGES.diskTilt.max], [-30, 30]);
  assert.deepEqual([PARAM_RANGES.lensingStrength.min, PARAM_RANGES.lensingStrength.max], [0, 1.5]);
  assert.deepEqual([PARAM_RANGES.timeScale.min, PARAM_RANGES.timeScale.max], [0, 5]);
});

test('DEFAULT_SETTINGS has the contract defaults', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    mass: 1,
    spin: 0,
    diskTemp: 6500,
    diskTilt: 0,
    lensingStrength: 1,
    timeScale: 1,
    orbitDecay: 0.35,
    orbitRadius: 14,
    massSolarPerUnit: 4.3e6,
    preset: 'custom',
    lensing: true,
    doppler: true,
    stars: true,
    disk: true,
    paused: false,
    hud: true,
    bloom: true,
    grain: true,
    quality: 'auto',
    cinematic: false,
    camera: { distance: 30, inclinationDeg: 80, azimuthDeg: 0 },
  });
});

test('presets describe physically distinct scenes in the intended order', () => {
  const { gargantua, sgrA, quiet } = PRESETS;
  assert.ok(gargantua.settings.spin >= 0.85, 'Gargantua spins fast');
  assert.ok(gargantua.settings.diskTemp < sgrA.settings.diskTemp, 'Gargantua is warmer/redder than Sgr A*');
  assert.ok(sgrA.settings.diskTilt >= 15, 'Sgr A* disk is tilted');
  assert.equal(quiet.settings.spin, 0);
  assert.equal(quiet.settings.diskTilt, 0);
  assert.ok(quiet.settings.diskTemp <= 3500, 'Quiet is cool');
  assert.ok(gargantua.massSolarPerUnit > sgrA.massSolarPerUnit && sgrA.massSolarPerUnit > quiet.massSolarPerUnit);
});

test('applyPreset returns a new object, sets preset + massSolarPerUnit + params, keeps other settings', () => {
  const input = createDefaultSettings();
  input.bloom = false;
  input.camera.distance = 12;
  const snapshot = structuredClone(input);

  for (const id of Object.keys(PRESETS)) {
    const out = applyPreset(input, id);
    assert.notEqual(out, input);
    assert.notEqual(out.camera, input.camera);
    assert.equal(out.preset, id);
    assert.equal(out.massSolarPerUnit, PRESETS[id].massSolarPerUnit);
    for (const key of RANGED) assert.equal(out[key], PRESETS[id].settings[key], `${id}.${key}`);
    assert.equal(out.bloom, false, 'unrelated toggles preserved');
    assert.equal(out.camera.distance, 12, 'camera preserved');
    out.camera.distance = 99; // mutating the output must not leak into the input
    assert.equal(input.camera.distance, 12);
  }
  assert.deepEqual(input, snapshot, 'input untouched');
});

test('applyPreset throws on an unknown id (including inherited object keys)', () => {
  assert.throws(() => applyPreset(DEFAULT_SETTINGS, 'nope'), /Unknown preset/);
  assert.throws(() => applyPreset(DEFAULT_SETTINGS, 'constructor'));
  assert.throws(() => applyPreset(DEFAULT_SETTINGS, undefined));
  assert.throws(() => applyPreset(DEFAULT_SETTINGS, 'custom'));
});

test('clampSettings clamps every ranged parameter without mutating the input', () => {
  const wild = {
    ...createDefaultSettings(),
    mass: 99,
    spin: -1,
    diskTemp: 1,
    diskTilt: 500,
    lensingStrength: 7,
    timeScale: -3,
  };
  const snapshot = structuredClone(wild);
  const out = clampSettings(wild);
  assert.deepEqual(wild, snapshot);
  assert.notEqual(out, wild);
  assert.equal(out.mass, PARAM_RANGES.mass.max);
  assert.equal(out.spin, PARAM_RANGES.spin.min);
  assert.equal(out.diskTemp, PARAM_RANGES.diskTemp.min);
  assert.equal(out.diskTilt, PARAM_RANGES.diskTilt.max);
  assert.equal(out.lensingStrength, PARAM_RANGES.lensingStrength.max);
  assert.equal(out.timeScale, PARAM_RANGES.timeScale.min);
  const low = clampSettings({ ...wild, mass: 0, diskTilt: -500, spin: 5 });
  assert.equal(low.mass, PARAM_RANGES.mass.min);
  assert.equal(low.diskTilt, PARAM_RANGES.diskTilt.min);
  assert.equal(low.spin, PARAM_RANGES.spin.max);
});

test('clampSettings leaves in-range values and other keys alone, repairs non-finite values', () => {
  const ok = applyPreset(createDefaultSettings(), 'gargantua');
  assert.deepEqual(clampSettings(ok), ok);
  const bad = clampSettings({ ...ok, mass: NaN, spin: 'abc' });
  assert.equal(bad.mass, PARAM_RANGES.mass.default);
  assert.equal(bad.spin, PARAM_RANGES.spin.default);
  assert.equal(clampSettings({ ...ok, quality: 5 }).quality, 1);
  assert.equal(clampSettings({ ...ok, quality: 0.1 }).quality, 0.5);
  assert.equal(clampSettings({ ...ok, quality: 'auto' }).quality, 'auto');
});

test('createDefaultSettings returns an independent copy', () => {
  const a = createDefaultSettings();
  a.camera.distance = 1;
  a.mass = 2;
  assert.equal(DEFAULT_SETTINGS.camera.distance, 30);
  assert.equal(DEFAULT_SETTINGS.mass, 1);
  assert.deepEqual(createDefaultSettings(), DEFAULT_SETTINGS);
});

test('orbit settings: ranges, defaults, presets leave them alone, clampSettings clamps them', () => {
  assert.deepEqual(
    { ...PARAM_RANGES.orbitDecay },
    { min: 0, max: 1, step: 0.01, default: 0.35, label: 'Orbit decay', unit: '' },
  );
  assert.deepEqual(
    { ...PARAM_RANGES.orbitRadius },
    { min: 8, max: 30, step: 0.5, default: 14, label: 'Orbit radius', unit: 'M' },
  );
  assert.equal(DEFAULT_SETTINGS.orbitDecay, 0.35);
  assert.equal(DEFAULT_SETTINGS.orbitRadius, 14);
  for (const [id, preset] of Object.entries(PRESETS)) {
    assert.ok(!('orbitDecay' in preset.settings) && !('orbitRadius' in preset.settings), `${id} must not set orbit params`);
  }
  const custom = { ...createDefaultSettings(), orbitDecay: 0.8, orbitRadius: 20 };
  const applied = applyPreset(custom, 'gargantua');
  assert.equal(applied.orbitDecay, 0.8);
  assert.equal(applied.orbitRadius, 20);
  const hi = clampSettings({ ...custom, orbitDecay: 5, orbitRadius: 99 });
  assert.equal(hi.orbitDecay, 1);
  assert.equal(hi.orbitRadius, 30);
  const lo = clampSettings({ ...custom, orbitDecay: -1, orbitRadius: 1 });
  assert.equal(lo.orbitDecay, 0);
  assert.equal(lo.orbitRadius, 8);
  const bad = clampSettings({ ...custom, orbitDecay: NaN, orbitRadius: 'x' });
  assert.equal(bad.orbitDecay, 0.35);
  assert.equal(bad.orbitRadius, 14);
});
