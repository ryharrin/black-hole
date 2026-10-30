import { BodyPropagator, createBody } from './body.js';

// Probes fall under the Schwarzschild geodesic in proper time (the probe's own clock), while the
// "apparent" view is what a distant static observer sees (see body.js): the same worldline replayed
// against Schwarzschild coordinate time, which diverges at the horizon, so the probe appears to freeze.

const BODY_RADIUS = 0.32; // M units; ship half-length
const DEFAULT_DROP_RADIUS_RS = 10;
const DEFAULT_TANGENTIAL = 0.15; // × sqrt(M/r)
const DEFAULT_INWARD = 0.5; // × sqrt(M/r)

function checkVec3(name, v) {
  if (!Array.isArray(v) && !ArrayBuffer.isView(v)) {
    throw new TypeError(`Probe ${name} must be an array of three numbers.`);
  }
  if (v.length !== 3) throw new TypeError(`Probe ${name} must have three components.`);
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(v[i])) throw new TypeError(`Probe ${name} must contain finite numbers.`);
  }
}

export class ProbeSystem {
  constructor(maxProbes = 8) {
    this.maxProbes = maxProbes;
    this.nextId = 1;
    this.time = 0; // observer (far-away static clock) time T, advances by dtSim
    this.list = []; // ProbeState[], oldest first
    this._internal = []; // parallel to list
    this._body = new BodyPropagator();
  }

  /** Drops a probe; default is r = 10 r_s on the camera side (or +z), slightly off-plane, nearly radial. Returns its id. */
  drop({ position, velocity } = {}, mass = 1, cameraPosition) {
    const rs = 2 * mass;
    if (position !== undefined) checkVec3('position', position);
    if (velocity !== undefined) checkVec3('velocity', velocity);
    if (cameraPosition !== undefined) checkVec3('cameraPosition', cameraPosition);

    let px;
    let py;
    let pz;
    if (position !== undefined) {
      px = position[0];
      py = position[1];
      pz = position[2];
    } else {
      let dx = 0;
      let dy = 0;
      let dz = 1;
      if (cameraPosition !== undefined) {
        const len = Math.hypot(cameraPosition[0], cameraPosition[1], cameraPosition[2]);
        if (len > 0) {
          dx = cameraPosition[0] / len;
          dy = cameraPosition[1] / len;
          dz = cameraPosition[2] / len;
        }
      }
      if (Math.abs(dy) < 0.1) dy = dy < 0 ? -0.1 : 0.1; // keep it off the disk plane
      const n = Math.hypot(dx, dy, dz);
      const r0 = DEFAULT_DROP_RADIUS_RS * rs;
      px = (dx / n) * r0;
      py = (dy / n) * r0;
      pz = (dz / n) * r0;
    }

    const r = Math.hypot(px, py, pz);
    let vx;
    let vy;
    let vz;
    if (velocity !== undefined) {
      vx = velocity[0];
      vy = velocity[1];
      vz = velocity[2];
    } else {
      // Small tangential push (horizontal, ⟂ radial) plus a modest inward speed, both scaled by sqrt(M/r).
      const scale = Math.sqrt(mass / Math.max(r, 1e-9));
      // Horizontal tangent y × r̂ (always ⟂ r̂); along +z when the position is on the y axis.
      let tx = pz;
      let tz = -px;
      const tl = Math.hypot(tx, tz);
      if (tl < 1e-6 * r) {
        tx = 0;
        tz = 1;
      } else {
        tx /= tl;
        tz /= tl;
      }
      const ty = 0;
      vx = DEFAULT_TANGENTIAL * scale * tx - DEFAULT_INWARD * scale * (px / r);
      vy = DEFAULT_TANGENTIAL * scale * ty - DEFAULT_INWARD * scale * (py / r);
      vz = DEFAULT_TANGENTIAL * scale * tz - DEFAULT_INWARD * scale * (pz / r);
    }

    const { state, internal } = createBody(this.nextId++, [px, py, pz], [vx, vy, vz], mass, this.time);
    state.kind = 'probe';
    state.bodyRadius = BODY_RADIUS;

    if (this.list.length >= this.maxProbes) {
      this.list.shift();
      this._internal.shift();
    }
    this.list.push(state);
    this._internal.push(internal);
    this._body.updateApparent(state, internal, mass, this.time);
    return state.id;
  }

  /** Removes all probes. */
  clear() {
    this.list.length = 0;
    this._internal.length = 0;
  }

  /** Advances every probe by dtSim of proper time, and the observer clock by dtSim. Allocation-free. */
  step(dtSim, mass) {
    if (!(dtSim >= 0)) dtSim = 0;
    this.time += dtSim;
    for (let i = 0; i < this.list.length; i++) {
      const state = this.list[i];
      const p = this._internal[i];
      if (!state.captured && dtSim > 0) this._body.advance(state, p, dtSim, mass);
      this._body.updateApparent(state, p, mass, this.time);
    }
  }

}
