import { timeDilation, tidalStretch, radiationReactionAccel } from './schwarzschild.js';

// Shared point-body machinery for probes and orbiters. A body falls under the Schwarzschild geodesic in
// proper time (RK4 on the Binet-form acceleration, optionally plus gravitational-wave radiation reaction),
// while the "apparent" view is what a distant static observer sees: the same worldline replayed against
// Schwarzschild coordinate time, which diverges at the horizon, so the body appears to freeze.

const SUBSTEP_RS = 0.03; // RK4 substep ≤ this × r_s of proper time (0.06 at M = 1)
const MAX_SUBSTEPS = 4096; // guards against a single huge dt (e.g. a backgrounded tab)
export const HISTORY_CAPACITY = 2048; // samples per body, decimated when full
const STRIDE = 7; // (coordTime, x, y, z, vx, vy, vz) per sample; v is the local static-observer velocity
const FINAL_SAMPLE_EPS = 0.002; // last exterior sample sits at r = r_s (1 + eps)
const EXTRAPOLATION_EFOLD = 1; // exact e-fold time of r - r_s ∝ exp(-t/2M) = exp(-t/r_s), in units of r_s
const FROZEN_FRACTION = 0.02; // frozen when apparent r - r_s < 0.02 r_s
const MAX_LOCAL_SPEED = 0.9999; // apparent.velocity is clamped to |v| ≤ this (it → 1 at the horizon)
const PLUNGE_TAPER_START = 3.5; // radiation reaction fades smoothly from full at r = 6M (ISCO) to 0 at 3.5M
const PLUNGE_TAPER_FULL = 6;

/** Specific energy E from the current state: E² = ṙ² + (1 - 2M/r)(1 + L²/r²). */
export function specificEnergy(s, l2, mass) {
  const r2 = s[0] * s[0] + s[1] * s[1] + s[2] * s[2];
  const r = Math.sqrt(r2);
  const radial = (s[0] * s[3] + s[1] * s[4] + s[2] * s[5]) / r;
  const f = Math.max(0, 1 - (2 * mass) / r);
  return Math.sqrt(Math.max(1e-12, radial * radial + f * (1 + l2 / r2)));
}

function angularMomentumSq(s) {
  return (s[1] * s[5] - s[2] * s[4]) ** 2 + (s[2] * s[3] - s[0] * s[5]) ** 2 + (s[0] * s[4] - s[1] * s[3]) ** 2;
}

/**
 * Velocity (fraction of c) of the body as measured by a local static observer, written to out[o..o+2]:
 * radial ṙ/E, tangential (L/r)·sqrt(1 - 2M/r)/E (E = specific energy), clamped below 1.
 */
export function localStaticVelocity(s, mass, energy, out, o) {
  const r2 = s[0] * s[0] + s[1] * s[1] + s[2] * s[2];
  const r = Math.sqrt(r2);
  if (!(r > 0)) {
    out[o] = out[o + 1] = out[o + 2] = 0;
    return;
  }
  const nx = s[0] / r;
  const ny = s[1] / r;
  const nz = s[2] / r;
  const vr = s[3] * nx + s[4] * ny + s[5] * nz;
  const sqrtF = Math.sqrt(Math.max(0, 1 - (2 * mass) / r));
  const k = sqrtF / energy;
  // v_local = (ṙ r̂ + sqrt(f) (v - ṙ r̂)) / E = (sqrt(f) v + (1 - sqrt(f)) ṙ r̂) / E
  const kr = (vr * (1 - sqrtF)) / energy;
  let vx = (s[3] * k) + nx * kr;
  let vy = (s[4] * k) + ny * kr;
  let vz = (s[5] * k) + nz * kr;
  const speed = Math.hypot(vx, vy, vz);
  if (speed > MAX_LOCAL_SPEED) {
    const c = MAX_LOCAL_SPEED / speed;
    vx *= c;
    vy *= c;
    vz *= c;
  }
  out[o] = vx;
  out[o + 1] = vy;
  out[o + 2] = vz;
}

/**
 * Creates the public state plus internal integrator record for a body at `position` with proper-time
 * velocity `velocity` (scene units). `startTime` is the observer clock value at creation.
 * The caller adds its own fields to `state` and calls `propagator.updateApparent` once.
 */
export function createBody(id, position, velocity, mass, startTime) {
  const [px, py, pz] = position;
  const [vx, vy, vz] = velocity;
  const rs = 2 * mass;
  const s = new Float64Array([px, py, pz, vx, vy, vz]);
  const l2 = angularMomentumSq(s);
  const r = Math.hypot(px, py, pz);
  const captured = r <= rs;
  const energy = specificEnergy(s, l2, mass);

  const hist = new Float64Array(HISTORY_CAPACITY * STRIDE);
  hist[1] = px;
  hist[2] = py;
  hist[3] = pz;
  localStaticVelocity(s, mass, energy, hist, 4);

  const state = {
    id,
    position: [px, py, pz],
    velocity: [vx, vy, vz],
    r,
    captured,
    properTime: 0,
    coordTime: 0,
    timeDilation: timeDilation(r, mass),
    apparent: {
      position: [px, py, pz],
      velocity: [hist[4], hist[5], hist[6]],
      r,
      redshift: timeDilation(r, mass),
      stretch: tidalStretch(r, mass),
      frozen: captured,
    },
  };
  const internal = {
    s,
    l2,
    l2Stale: false, // true after a radiation-reaction step: L² must be re-read from the state
    mass,
    energy,
    hist,
    n: 1,
    startTime, // observer time at creation
    azimuth: 0, // accumulated swept angle about the instantaneous angular momentum axis (rad)
  };
  return { state, internal };
}

/** Allocation-free RK4 stepper and apparent-view updater; one instance holds the scratch buffers. */
export class BodyPropagator {
  constructor() {
    this._k = Array.from({ length: 4 }, () => new Float64Array(6));
    this._tmp = new Float64Array(6);
    this._prev = new Float64Array(6);
    this._mix = new Float64Array(6);
    this._acc = [0, 0, 0];
    this._vel = [0, 0, 0];
  }

  // Binet-form geodesic acceleration (exact for proper-time Schwarzschild orbits) + radiation reaction when q > 0.
  _derivative(s, l2, mass, q, out) {
    const r2 = s[0] * s[0] + s[1] * s[1] + s[2] * s[2];
    const invR = 1 / Math.sqrt(r2);
    // a = -M x/r³ - 3 M L² x/r⁵; with reaction the instantaneous L² = |x × v|² is used.
    const L2 = q > 0 ? angularMomentumSq(s) : l2;
    const factor = ((-mass * invR) / r2) * (1 + (3 * L2) / r2);
    for (let i = 0; i < 3; i++) {
      out[i] = s[i + 3];
      out[i + 3] = s[i] * factor;
    }
    if (q > 0) {
      // The Peters force is an adiabatic, quasi-circular result. Inside the ISCO the body is on a
      // plunge, where the force (∝ 1/(r⁵|v|)) would otherwise brake it to a halt; fade it out there.
      const t = Math.min(1, Math.max(0, (Math.sqrt(r2) / mass - PLUNGE_TAPER_START) / (PLUNGE_TAPER_FULL - PLUNGE_TAPER_START)));
      const w = t * t * (3 - 2 * t);
      if (w > 0) {
        const v = this._vel;
        v[0] = s[3];
        v[1] = s[4];
        v[2] = s[5];
        const a = radiationReactionAccel(s, v, mass, q * w, this._acc);
        out[3] += a[0];
        out[4] += a[1];
        out[5] += a[2];
      }
    }
  }

  /** Advances one body by dt of proper time. `q` is the radiation-reaction mass ratio (0 = pure geodesic). */
  advance(state, p, dt, mass, q = 0) {
    if (q > 0) {
      p.l2Stale = true;
    } else if (p.l2Stale) {
      p.l2 = angularMomentumSq(p.s);
      p.l2Stale = false;
      p.energy = specificEnergy(p.s, p.l2, mass);
    }
    if (mass !== p.mass) {
      p.mass = mass;
      if (q > 0) p.l2 = angularMomentumSq(p.s);
      p.energy = specificEnergy(p.s, p.l2, mass);
    }
    const rs = 2 * mass;
    const steps = Math.min(MAX_SUBSTEPS, Math.ceil(dt / (SUBSTEP_RS * rs)));
    const h = dt / steps;
    const s = p.s;
    const k = this._k;
    const tmp = this._tmp;
    const prev = this._prev;

    for (let n = 0; n < steps && !state.captured; n++) {
      prev.set(s);
      const rBefore = Math.hypot(s[0], s[1], s[2]);
      this._derivative(s, p.l2, mass, q, k[0]);
      for (let stage = 1; stage < 4; stage++) {
        const scale = stage === 3 ? h : h / 2;
        for (let i = 0; i < 6; i++) tmp[i] = s[i] + scale * k[stage - 1][i];
        this._derivative(tmp, p.l2, mass, q, k[stage]);
      }
      for (let i = 0; i < 6; i++) {
        s[i] += (h / 6) * (k[0][i] + 2 * k[1][i] + 2 * k[2][i] + k[3][i]);
      }
      const rAfter = Math.hypot(s[0], s[1], s[2]);
      if (q > 0) {
        p.l2 = angularMomentumSq(s);
        p.energy = specificEnergy(s, p.l2, mass);
      }

      if (rAfter <= rs) {
        // Crossing: finish the step at the horizon (proper time), and cap the coordinate-time
        // record at a last exterior sample r = r_s(1 + eps) so the observer replay stays finite.
        const span = rBefore - rAfter;
        const fCross = span > 0 ? Math.min(1, Math.max(0, (rBefore - rs) / span)) : 1;
        const rEps = rs * (1 + FINAL_SAMPLE_EPS);
        if (rBefore > rEps && span > 0) {
          const fEps = Math.min(fCross, (rBefore - rEps) / span);
          const rMid = (rBefore + rEps) / 2;
          state.coordTime += (h * fEps * p.energy) / (1 - rs / rMid);
          this._pushSample(p, state.coordTime, prev, s, fEps, mass);
        }
        for (let i = 0; i < 6; i++) s[i] = prev[i] + fCross * (s[i] - prev[i]);
        const radius = Math.hypot(s[0], s[1], s[2]);
        for (let i = 0; i < 3; i++) s[i] *= rs / radius;
        state.properTime += h * fCross;
        state.captured = true;
      } else {
        const rMid = (rBefore + rAfter) / 2;
        state.coordTime += (h * p.energy) / (1 - rs / rMid);
        state.properTime += h;
        this._pushSample(p, state.coordTime, null, s, 1, mass);
      }

      // Swept azimuth about the instantaneous angular momentum axis.
      const cx = prev[1] * s[2] - prev[2] * s[1];
      const cy = prev[2] * s[0] - prev[0] * s[2];
      const cz = prev[0] * s[1] - prev[1] * s[0];
      const lx = s[1] * s[5] - s[2] * s[4];
      const ly = s[2] * s[3] - s[0] * s[5];
      const lz = s[0] * s[4] - s[1] * s[3];
      const ll = Math.hypot(lx, ly, lz);
      if (ll > 0) {
        const dot = prev[0] * s[0] + prev[1] * s[1] + prev[2] * s[2];
        p.azimuth += Math.atan2((cx * lx + cy * ly + cz * lz) / ll, dot);
      }
    }

    state.position[0] = s[0];
    state.position[1] = s[1];
    state.position[2] = s[2];
    state.velocity[0] = s[3];
    state.velocity[1] = s[4];
    state.velocity[2] = s[5];
    state.r = Math.hypot(s[0], s[1], s[2]);
    state.timeDilation = state.captured ? 0 : timeDilation(state.r, mass);
  }

  // Appends (t, position, local velocity) where the state is from + f (to - from) (or `to` when from is null).
  _pushSample(p, t, from, to, f, mass) {
    if (p.n >= HISTORY_CAPACITY) this._decimate(p);
    const o = p.n * STRIDE;
    const h = p.hist;
    h[o] = t;
    let src = to;
    if (from !== null) {
      src = this._mix;
      for (let i = 0; i < 6; i++) src[i] = from[i] + f * (to[i] - from[i]);
    }
    for (let i = 0; i < 3; i++) h[o + 1 + i] = src[i];
    localStaticVelocity(src, mass, p.energy, h, o + 4);
    p.n++;
  }

  // Halves the sample density in place, keeping the first and last samples.
  _decimate(p) {
    const h = p.hist;
    const n = p.n;
    let w = 0;
    for (let i = 0; i < n; i += 2) {
      if (w !== i) for (let c = 0; c < STRIDE; c++) h[w * STRIDE + c] = h[i * STRIDE + c];
      w++;
    }
    if ((n - 1) % 2 === 1) {
      for (let c = 0; c < STRIDE; c++) h[w * STRIDE + c] = h[(n - 1) * STRIDE + c];
      w++;
    }
    p.n = w;
  }

  /** Sets state.apparent to the body as a distant observer sees it at observer clock `time`. */
  updateApparent(state, p, mass, time) {
    const rs = 2 * mass;
    const app = state.apparent;
    const hist = p.hist;
    const n = p.n;
    const T = time - p.startTime;
    const lastT = hist[(n - 1) * STRIDE];
    let x;
    let y;
    let z;
    let ux;
    let uy;
    let uz;

    if (T >= lastT) {
      const o = (n - 1) * STRIDE;
      x = hist[o + 1];
      y = hist[o + 2];
      z = hist[o + 3];
      ux = hist[o + 4];
      uy = hist[o + 5];
      uz = hist[o + 6];
      if (state.captured) {
        const rLast = Math.hypot(x, y, z);
        // Never reaches r_s: floored a hair above it so redshift stays > 0 despite float underflow.
        const rApp = Math.max(
          rs * (1 + 1e-9),
          rs + Math.max(0, rLast - rs) * Math.exp(-(T - lastT) / (EXTRAPOLATION_EFOLD * rs)),
        );
        const scale = rLast > 0 ? rApp / rLast : 0;
        x *= scale;
        y *= scale;
        z *= scale;
      }
    } else {
      // Binary search for the last sample with t <= T (hist[0] is t = 0 <= T).
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (hist[mid * STRIDE] <= T) lo = mid;
        else hi = mid;
      }
      const a = lo * STRIDE;
      const b = hi * STRIDE;
      const span = hist[b] - hist[a];
      const f = span > 0 ? Math.min(1, Math.max(0, (T - hist[a]) / span)) : 0;
      // Interpolate radius linearly and direction by normalised lerp: a chord between sparse samples on a
      // curved (spiralling) path must never dip inside the horizon.
      const ra = Math.hypot(hist[a + 1], hist[a + 2], hist[a + 3]);
      const rb = Math.hypot(hist[b + 1], hist[b + 2], hist[b + 3]);
      const dx = hist[a + 1] / ra + f * (hist[b + 1] / rb - hist[a + 1] / ra);
      const dy = hist[a + 2] / ra + f * (hist[b + 2] / rb - hist[a + 2] / ra);
      const dz = hist[a + 3] / ra + f * (hist[b + 3] / rb - hist[a + 3] / ra);
      const dl = Math.hypot(dx, dy, dz);
      const rr = ra + f * (rb - ra);
      if (dl > 1e-12 && ra > 0 && rb > 0) {
        x = (dx / dl) * rr;
        y = (dy / dl) * rr;
        z = (dz / dl) * rr;
      } else {
        x = hist[a + 1] + f * (hist[b + 1] - hist[a + 1]);
        y = hist[a + 2] + f * (hist[b + 2] - hist[a + 2]);
        z = hist[a + 3] + f * (hist[b + 3] - hist[a + 3]);
      }
      ux = hist[a + 4] + f * (hist[b + 4] - hist[a + 4]);
      uy = hist[a + 5] + f * (hist[b + 5] - hist[a + 5]);
      uz = hist[a + 6] + f * (hist[b + 6] - hist[a + 6]);
    }

    const r = Math.hypot(x, y, z);
    app.position[0] = x;
    app.position[1] = y;
    app.position[2] = z;
    app.velocity[0] = ux;
    app.velocity[1] = uy;
    app.velocity[2] = uz;
    app.r = r;
    app.redshift = timeDilation(r, mass);
    app.stretch = tidalStretch(r, mass);
    app.frozen = r - rs < FROZEN_FRACTION * rs;
  }
}
