import { BodyPropagator, createBody } from './body.js';
import { decayCoefficient, petersInspiralTime } from './schwarzschild.js';

// Stars and planets on Schwarzschild geodesic orbits that lose energy to (exaggerated) gravitational
// radiation: spiral in, pass the ISCO, plunge, and appear to freeze at the horizon for a distant observer.

export const MAX_ORBITERS = 8;

const ISCO_RS = 3; // Schwarzschild ISCO = 6M = 3 r_s (geodesics here are Schwarzschild)
const ORBITING_ABOVE_ISCO = 1.5; // 'orbiting' while r > 1.5 · ISCO
const DEFAULT_INCLINATION_DEG = 12; // random inclination ±
const DEFAULT_MAX_ECCENTRICITY = 0.08;
const MIN_SPAWN_RADIUS_M = 3.5; // below the photon sphere there is no circular speed

const STAR_RADIUS = [0.42, 0.6];
const STAR_TEMPERATURE = [2800, 22000]; // log-uniform by seed
const PLANET_RADIUS = [0.22, 0.34];
const PLANET_STYLES = ['gas', 'rocky', 'ice'];

/** Small deterministic PRNG (mulberry32): returns a function giving floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Appearance (and the PRNG positioned after it) fully determined by seed and kind. */
function appearance(seed, kind) {
  const rand = mulberry32(seed);
  const u1 = rand();
  const u2 = rand();
  const u3 = rand();
  if (kind === 'planet') {
    return {
      rand,
      bodyRadius: PLANET_RADIUS[0] + u1 * (PLANET_RADIUS[1] - PLANET_RADIUS[0]),
      temperature: 0,
      style: PLANET_STYLES[Math.min(PLANET_STYLES.length - 1, Math.floor(u3 * PLANET_STYLES.length))],
    };
  }
  return {
    rand,
    bodyRadius: STAR_RADIUS[0] + u1 * (STAR_RADIUS[1] - STAR_RADIUS[0]),
    temperature: STAR_TEMPERATURE[0] * Math.pow(STAR_TEMPERATURE[1] / STAR_TEMPERATURE[0], u2),
    style: 'star',
  };
}

function statusOf(captured, r, q, mass) {
  if (captured) return 'captured';
  const isco = ISCO_RS * 2 * mass;
  if (r < isco) return 'plunging';
  if (!(q > 0) || r > ORBITING_ABOVE_ISCO * isco) return 'orbiting';
  return 'inspiral';
}

export class OrbiterSystem {
  constructor(max = MAX_ORBITERS) {
    this.max = max;
    this.nextId = 1;
    this.time = 0; // observer (far-away static clock) time, advances by dtSim
    this.list = []; // OrbiterState[], oldest first
    this._internal = []; // parallel to list
    this._body = new BodyPropagator();
  }

  /**
   * Spawns a star or planet on a prograde orbit in the (tilted) disk sense and returns its id.
   * opts: { kind, radius (scene units, the semi-major axis), phase (rad), inclinationDeg, eccentricity, seed }.
   * It starts at apoapsis radius·(1 + e) with the Schwarzschild circular speed there × sqrt(1 - e).
   */
  add(opts = {}, mass = 1, settings = {}) {
    const kind = opts.kind === 'planet' ? 'planet' : 'star';
    const seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : Math.floor(Math.random() * 4294967296) >>> 0;
    const look = appearance(seed, kind);
    const rand = look.rand;

    const radius = Math.max(
      MIN_SPAWN_RADIUS_M * mass,
      Number.isFinite(opts.radius) ? opts.radius : (settings.orbitRadius ?? 14) * mass,
    );
    const phase = Number.isFinite(opts.phase) ? opts.phase : rand() * 2 * Math.PI;
    const incDeg = Number.isFinite(opts.inclinationDeg)
      ? opts.inclinationDeg
      : (rand() * 2 - 1) * DEFAULT_INCLINATION_DEG;
    const ecc = Math.min(
      0.9,
      Math.max(0, Number.isFinite(opts.eccentricity) ? opts.eccentricity : rand() * DEFAULT_MAX_ECCENTRICITY),
    );

    // Orbital frame: disk normal n = +y rotated about x by diskTilt; in-plane basis e1 = x, e2 = n × e1,
    // then the plane is inclined by incDeg about e1 (the line of nodes).
    const tilt = ((settings.diskTilt ?? 0) * Math.PI) / 180;
    const inc = (incDeg * Math.PI) / 180;
    const ny = Math.cos(tilt);
    const nz = Math.sin(tilt);
    const e2y = nz;
    const e2z = -ny;
    const ci = Math.cos(inc);
    const si = Math.sin(inc);
    const uy = ci * e2y + si * ny; // e2' = cos i e2 + sin i n  (x component is 0)
    const uz = ci * e2z + si * nz;

    const cp = Math.cos(phase);
    const sp = Math.sin(phase);
    const apo = radius * (1 + ecc); // spawn at apoapsis so `radius` is the semi-major axis
    const position = [apo * cp, apo * sp * uy, apo * sp * uz];
    const vCirc = Math.sqrt(mass / (apo - 3 * mass)); // L/r of a Schwarzschild circular orbit, d/dτ
    const speed = vCirc * Math.sqrt(1 - ecc);
    const velocity = [-speed * sp, speed * cp * uy, speed * cp * uz];

    const { state, internal } = createBody(this.nextId++, position, velocity, mass, this.time);
    const q = decayCoefficient(settings.orbitDecay ?? 0);
    state.kind = kind;
    state.seed = seed;
    state.bodyRadius = look.bodyRadius;
    state.temperature = look.temperature;
    state.style = look.style;
    state.orbits = 0;
    state.status = statusOf(state.captured, state.r, q, mass);
    state.inspiralTime = state.captured ? 0 : petersInspiralTime(state.r, mass, q);

    if (this.list.length >= this.max) {
      this.list.shift();
      this._internal.shift();
    }
    this.list.push(state);
    this._internal.push(internal);
    this._body.updateApparent(state, internal, mass, this.time);
    return state.id;
  }

  /** Removes all orbiters. */
  clear() {
    this.list.length = 0;
    this._internal.length = 0;
  }

  /**
   * Advances every orbiter by dtSim of proper time (and the observer clock by dtSim) with the Schwarzschild
   * geodesic plus radiation reaction of mass ratio q (0 = stable orbits). Allocation-free.
   */
  step(dtSim, mass, q = 0) {
    if (!(dtSim >= 0)) dtSim = 0;
    if (!(q > 0)) q = 0;
    this.time += dtSim;
    for (let i = 0; i < this.list.length; i++) {
      const state = this.list[i];
      const p = this._internal[i];
      if (!state.captured && dtSim > 0) this._body.advance(state, p, dtSim, mass, q);
      this._body.updateApparent(state, p, mass, this.time);
      state.orbits = p.azimuth / (2 * Math.PI);
      state.status = statusOf(state.captured, state.r, q, mass);
      state.inspiralTime = state.captured ? 0 : petersInspiralTime(state.r, mass, q);
    }
  }
}
