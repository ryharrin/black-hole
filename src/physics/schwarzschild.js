// Pure Schwarzschild / thin-disk helpers in geometric units (G = c = 1). The GLSL shader mirrors these formulas.

const KM_PER_SOLAR_MASS_GM = 2.95325; // GM_sun / c^2 in km; r_s = 2 * this per solar mass

/** Schwarzschild radius r_s = 2M (geometric units). */
export function schwarzschildRadius(mass) {
  return 2 * mass;
}

/** Schwarzschild radius in km for a mass given in solar masses (2.95325 km per M_sun). */
export function schwarzschildRadiusKm(massSolar) {
  return KM_PER_SOLAR_MASS_GM * massSolar;
}

/** Static-observer time dilation dτ/dt = sqrt(1 - 2M/r); 0 at or inside the horizon. */
export function timeDilation(r, mass) {
  const rs = 2 * mass;
  if (!(r > rs)) return 0;
  return Math.sqrt(1 - rs / r);
}

/** Local circular-orbit speed (fraction of c) seen by a static observer, sqrt(M/(r-2M)); 0.999 cap and inside r <= 3M. */
export function keplerBeta(r, mass) {
  if (!(r > 3 * mass)) return 0.999;
  return Math.min(0.999, Math.sqrt(mass / (r - 2 * mass)));
}

/** Lorentz factor γ = 1/sqrt(1 - β²). */
export function lorentzFactor(beta) {
  return 1 / Math.sqrt(1 - beta * beta);
}

/** Relativistic Doppler factor 1/(γ(1 - β cosθ)); cosθ is between emitter velocity and the direction to the observer. */
export function dopplerFactor(beta, cosTheta) {
  return 1 / (lorentzFactor(beta) * (1 - beta * cosTheta));
}

/** Total frequency ratio g = ν_obs/ν_emit = sqrt(1 - 2M/r) × Doppler factor. */
export function diskRedshift(r, mass, beta, cosTheta) {
  return timeDilation(r, mass) * dopplerFactor(beta, cosTheta);
}

/** Observed/emitted bolometric intensity ratio g^exponent (exponent 4 by default: I_obs = g⁴ I_emit). */
export function beamedIntensity(g, exponent = 4) {
  return Math.pow(g, exponent);
}

/** Prograde ISCO radius (Bardeen–Press–Teukolsky) for spin a in [0, 1]: 6M at a = 0, → M as a → 1. */
export function iscoRadius(mass, spin) {
  const a = Math.min(1, Math.max(0, spin));
  const a2 = a * a;
  const z1 = 1 + Math.cbrt(1 - a2) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a2 + z1 * z1);
  return mass * (3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2)));
}

/** Photon sphere radius 3M. */
export function photonSphereRadius(mass) {
  return 3 * mass;
}

/** Shadow (critical impact parameter) radius 3√3 M as seen from infinity. */
export function shadowRadius(mass) {
  return 3 * Math.sqrt(3) * mass;
}

/** Einstein ring angle θ_E = sqrt(4M/D) in radians, for a source at infinity and lens distance D. */
export function einsteinAngle(mass, dLens) {
  return Math.sqrt((4 * mass) / dLens);
}

/** Visual tidal elongation of the probe: 1 beyond 15M, rising smoothly (quadratic) to 6 at the horizon. */
export function tidalStretch(r, mass) {
  const u = Math.min(1, Math.max(0, (15 * mass - r) / (13 * mass)));
  return 1 + 5 * u * u;
}

/** Radial star elongation seen from radius r: (1/timeDilation)(1 + 3|β_r|), clamped to [1, 8]. */
export function starStretchFactor(r, mass, radialBeta) {
  const td = timeDilation(r, mass);
  if (td <= 0) return 8;
  const f = (1 / td) * (1 + 3 * Math.abs(radialBeta));
  return Math.min(8, Math.max(1, f));
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Blackbody color for tempK (Tanner Helland fit, 1000–40000 K) as linear RGB in 0..1, scaled so the largest channel is 1. */
export function blackbodyColor(tempK) {
  const t = Math.min(40000, Math.max(1000, tempK)) / 100;
  let r;
  let g;
  let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const lin = [r, g, b].map((v) => srgbToLinear(Math.min(255, Math.max(0, v)) / 255));
  const peak = Math.max(lin[0], lin[1], lin[2]);
  return [lin[0] / peak, lin[1] / peak, lin[2] / peak];
}

// ---- Orbital decay (Peters gravitational-wave inspiral, deliberately exaggerated) ----

const DECAY_Q_AT_FULL = 4.5; // effective mass ratio at orbitDecay = 1
const DECAY_EXPONENT = 2.2; // q ∝ orbitDecay^2.2: gentle at low settings, brisk at high ones
const MIN_SPEED_SQ = 1e-4; // |v|² floor in the radiation-reaction force (it is singular at v → 0)

/**
 * Effective (exaggerated) mass ratio q = μ/M for the orbit-decay slider value in [0, 1]. Zero at 0, strictly
 * increasing. Real stellar mass ratios (~1e-6 and below) would take millions of years to decay; the slider
 * maps to q ≈ 0.006 … 4.5 so the whole inspiral plays out in seconds to minutes.
 */
export function decayCoefficient(orbitDecay) {
  const x = Number(orbitDecay);
  if (!(x > 0)) return 0;
  return DECAY_Q_AT_FULL * Math.pow(Math.min(1, x), DECAY_EXPONENT);
}

/** Peters circular-orbit gravitational-wave inspiral time 5 r⁴ / (256 q M³) (scene time); Infinity when q = 0. */
export function petersInspiralTime(r, mass, q) {
  if (!(q > 0)) return Infinity;
  return (5 * r ** 4) / (256 * q * mass ** 3);
}

/**
 * Radiation-reaction acceleration -(32/5) q M⁴ / (r⁵ |v|²) v, antiparallel to the velocity, sized so a circular
 * orbit loses specific energy at the Peters rate dE/dt = -(32/5) q M⁴/r⁵ (⇒ da/dt = -(64/5) q M³/a³).
 * (M⁴ rather than M³ keeps it dimensionally an acceleration; identical to M³ at M = 1.)
 * `out` (optional) receives the result to avoid allocation.
 */
export function radiationReactionAccel(position, velocity, mass, q, out = [0, 0, 0]) {
  const r2 = position[0] * position[0] + position[1] * position[1] + position[2] * position[2];
  const v2 = Math.max(MIN_SPEED_SQ, velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2]);
  const k = (-(32 / 5) * q * mass ** 4) / (r2 * r2 * Math.sqrt(r2) * v2);
  out[0] = k * velocity[0];
  out[1] = k * velocity[1];
  out[2] = k * velocity[2];
  return out;
}

/** Newtonian/Kepler orbital period 2π sqrt(r³/M) (scene time; Schwarzschild coordinate period is exactly this too). */
export function orbitalPeriod(r, mass) {
  return 2 * Math.PI * Math.sqrt((r * r * r) / mass);
}
