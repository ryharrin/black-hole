// Parameter ranges, default settings and named presets. No three import; safe to use from node tests.

export const PARAM_RANGES = {
  mass: { min: 0.5, max: 2.5, step: 0.05, default: 1, label: 'Mass', unit: 'M' },
  spin: { min: 0, max: 0.99, step: 0.01, default: 0, label: 'Spin', unit: 'a/M' },
  diskTemp: { min: 2500, max: 30000, step: 100, default: 6500, label: 'Disk temperature', unit: 'K' },
  diskTilt: { min: -30, max: 30, step: 1, default: 0, label: 'Disk tilt', unit: '°' },
  lensingStrength: { min: 0, max: 1.5, step: 0.05, default: 1, label: 'Lensing strength', unit: '×' },
  timeScale: { min: 0, max: 5, step: 0.05, default: 1, label: 'Time scale', unit: '×' },
  orbitDecay: { min: 0, max: 1, step: 0.01, default: 0.35, label: 'Orbit decay', unit: '' },
  orbitRadius: { min: 8, max: 30, step: 0.5, default: 14, label: 'Orbit radius', unit: 'M' },
};

export const DEFAULT_SETTINGS = {
  mass: PARAM_RANGES.mass.default,
  spin: PARAM_RANGES.spin.default,
  diskTemp: PARAM_RANGES.diskTemp.default,
  diskTilt: PARAM_RANGES.diskTilt.default,
  lensingStrength: PARAM_RANGES.lensingStrength.default,
  timeScale: PARAM_RANGES.timeScale.default,
  orbitDecay: PARAM_RANGES.orbitDecay.default,
  orbitRadius: PARAM_RANGES.orbitRadius.default,
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
};

export const PRESETS = {
  gargantua: {
    id: 'gargantua',
    label: 'Gargantua',
    description: 'Fast-spinning supermassive hole, warm amber disk, slight tilt, unhurried time.',
    massSolarPerUnit: 1e8,
    settings: { mass: 1, spin: 0.9, diskTemp: 4500, diskTilt: 4, lensingStrength: 1, timeScale: 0.5 },
  },
  sgrA: {
    id: 'sgrA',
    label: 'Sagittarius A*',
    description: 'Milky Way core: 4.3 million suns, moderate spin, hotter disk tilted 20°.',
    massSolarPerUnit: 4.3e6,
    settings: { mass: 1, spin: 0.5, diskTemp: 9000, diskTilt: 20, lensingStrength: 1, timeScale: 1 },
  },
  quiet: {
    id: 'quiet',
    label: 'Quiet',
    description: 'Non-spinning stellar-mass hole with a cool, dim, flat disk.',
    massSolarPerUnit: 10,
    settings: { mass: 1, spin: 0, diskTemp: 3000, diskTilt: 0, lensingStrength: 1, timeScale: 0.4 },
  },
};

/** Returns a copy of `settings` with the preset's values applied; throws on an unknown preset id. */
export function applyPreset(settings, id) {
  if (typeof id !== 'string' || !Object.hasOwn(PRESETS, id)) {
    throw new Error(`Unknown preset: ${String(id)}`);
  }
  const preset = PRESETS[id];
  return {
    ...settings,
    camera: { ...settings.camera },
    ...preset.settings,
    preset: id,
    massSolarPerUnit: preset.massSolarPerUnit,
  };
}

/** Returns a copy of `settings` with every ranged parameter (and numeric quality) clamped; non-finite values fall back to defaults. */
export function clampSettings(settings) {
  const out = { ...settings, camera: { ...settings.camera } };
  for (const [key, range] of Object.entries(PARAM_RANGES)) {
    const v = Number(settings[key]);
    out[key] = Number.isFinite(v) ? Math.min(range.max, Math.max(range.min, v)) : range.default;
  }
  if (typeof out.quality === 'number') {
    out.quality = Number.isFinite(out.quality) ? Math.min(1, Math.max(0.5, out.quality)) : 'auto';
  }
  return out;
}

/** Returns a fresh deep copy of DEFAULT_SETTINGS (safe to mutate). */
export function createDefaultSettings() {
  return { ...DEFAULT_SETTINGS, camera: { ...DEFAULT_SETTINGS.camera } };
}
