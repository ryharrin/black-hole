import { Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { cinematicPose, nearestCinematicPhase } from './cinematic.js';

const DEG = Math.PI / 180;
const MIN_DISTANCE_RS = 1.05; // closest approach, in Schwarzschild radii
const MAX_DISTANCE_M = 80; // farthest zoom, in M
const POLAR_EPS = 0.01; // rad; same pole margin the OrbitControls polar limits use
const FLY_RATE = 0.6; // 1/s: fly speed = FLY_RATE * (distance - rs), so approach to the horizon slows exponentially
const FLY_FLOOR_RS = 0.15; // minimum (distance - rs) used for speed, in rs, so flying out from 1.05 rs still gets going
const FLY_TAU = 0.35; // s, easing time constant of the fly velocity (ease in / ease out)
const BETA_MAX = 0.5; // cosmetic cap of |radialBeta|
const BETA_REF_M = 6; // speed reference, in M: FLY_RATE * BETA_REF_M * M maps to tanh(1) of BETA_MAX
const BETA_TAU = 0.08; // s, smoothing of the measured radial velocity
const CINEMATIC_BLEND = 5; // s, ease from the current camera into the scripted path (zero velocity+acceleration at start)

const smoothstep = (x) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * c * (c * (c * 6 - 15) + 10); // smootherstep
};
const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Camera rig: OrbitControls (drag orbit, wheel zoom, damping, no pan) + eased fly-in/out along the view
 * radius + a scripted cinematic mode. The camera always looks at the origin (the hole).
 *
 * Spherical convention (matches the v1 applyCamera): position =
 *   d * (sin(inc) * sin(az), cos(inc), sin(inc) * cos(az)); inc from +y pole, az 0 = +z toward +x.
 */
export class CameraRig {
  constructor(camera, domElement) {
    this.camera = camera;
    this.controls = new OrbitControls(camera, domElement);
    const controls = this.controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.enablePan = false;
    controls.minPolarAngle = POLAR_EPS;
    controls.maxPolarAngle = Math.PI - POLAR_EPS;
    controls.target.set(0, 0, 0);
    this._mass = 1;
    this._applyLimits(1);
    this._flight = 0;
    this._flightVel = 0; // signed d(distance)/dt of the eased fly motion
    this._cinematic = false;
    this.cinematicTime = 0;
    this._blendElapsed = 0;
    this._blendFrom = null;
    this._prevDistance = null; // null => skip radial velocity measurement this frame
    this._radialVel = 0;
    this._v = new Vector3();
  }

  get cinematic() {
    return this._cinematic;
  }

  /** Current pose, read back from the camera position (target is the origin). */
  getPose() {
    const p = this.camera.position;
    const distance = p.length();
    const inclinationDeg = distance > 0 ? Math.acos(Math.min(1, Math.max(-1, p.y / distance))) / DEG : 0;
    const azimuthDeg = ((Math.atan2(p.x, p.z) / DEG) % 360 + 360) % 360;
    return { distance, inclinationDeg, azimuthDeg };
  }

  /** Place the camera at `pose` (partial poses merge into the current one) and sync OrbitControls. */
  setPose(pose) {
    if (!this._cinematic) this._flushControls(); // drop drag inertia before an explicit placement
    const cur = this.getPose();
    const distance = pose.distance ?? cur.distance;
    const inclinationDeg = pose.inclinationDeg ?? cur.inclinationDeg;
    const azimuthDeg = pose.azimuthDeg ?? cur.azimuthDeg;
    this._place(distance, inclinationDeg, azimuthDeg);
    this._prevDistance = null;
    this._radialVel = 0;
    this._flightVel = 0;
  }

  /** -1 = fly in (toward the horizon), +1 = fly out, 0 = stop. Ignored while cinematic. */
  setFlight(dir) {
    this._flight = dir > 0 ? 1 : dir < 0 ? -1 : 0;
  }

  setCinematic(on) {
    on = !!on;
    if (on === this._cinematic) return;
    this._cinematic = on;
    this._flightVel = 0;
    this._radialVel = 0;
    this._prevDistance = null;
    if (on) {
      this._flushControls(); // drop drag inertia so the blend starts from where the camera visibly is
      this.controls.enabled = false;
      this._blendFrom = this.getPose();
      this.cinematicTime = nearestCinematicPhase(this._blendFrom, this._mass); // join the path near the current view
      this._blendElapsed = 0;
    } else {
      // Leave the camera exactly where it is; just hand control back to OrbitControls.
      this._flushControls();
      this.controls.enabled = true;
    }
  }

  /**
   * Advance the rig by dtReal seconds. Returns the camera distance and a cosmetic radial beta:
   * radialBeta = 0.5 * tanh(v / (0.6 * 6M)), v = smoothed d(distance)/dt (scene units / s), negative inbound.
   * It is signed, saturates at |0.5| and reaches ~0.38 when flying inbound at the speed of the fly law at 8M
   * (i.e. the fly speed near the hole). It is a visual driver for star stretching / aberration, not physical.
   */
  update(dtReal, mass) {
    const dt = Math.min(Math.max(dtReal, 0), 0.25);
    this._setMass(mass);
    const rs = 2 * mass;

    if (this._cinematic) {
      this.cinematicTime += dt;
      this._blendElapsed += dt;
      const target = cinematicPose(this.cinematicTime, mass);
      const w = smoothstep(this._blendElapsed / CINEMATIC_BLEND);
      const from = this._blendFrom;
      let distance = target.distance;
      let inc = target.inclinationDeg;
      let az = target.azimuthDeg;
      if (w < 1) {
        distance = Math.exp(Math.log(Math.max(from.distance, 1e-6)) * (1 - w) + Math.log(distance) * w);
        inc = from.inclinationDeg + (inc - from.inclinationDeg) * w;
        az = from.azimuthDeg + wrapDeg(az - from.azimuthDeg) * w;
      }
      this._place(distance, inc, az);
    } else {
      if (dt > 0) this._fly(dt, rs, mass);
      this.controls.update();
      this.camera.updateMatrixWorld();
    }

    const distance = this.camera.position.length();
    if (dt > 0 && this._prevDistance !== null) {
      const v = (distance - this._prevDistance) / dt;
      this._radialVel += (v - this._radialVel) * (1 - Math.exp(-dt / BETA_TAU));
    }
    this._prevDistance = distance;
    const vRef = FLY_RATE * BETA_REF_M * mass;
    return { distance, radialBeta: BETA_MAX * Math.tanh(this._radialVel / vRef) };
  }

  dispose() {
    this.controls.dispose();
  }

  _fly(dt, rs, mass) {
    const distance = this.camera.position.length();
    const lo = MIN_DISTANCE_RS * rs;
    const hi = MAX_DISTANCE_M * mass;
    let target = 0;
    if (this._flight !== 0) {
      const speed = FLY_RATE * Math.max(distance - rs, FLY_FLOOR_RS * rs);
      target = this._flight * speed; // flight -1 = inbound => negative d(distance)/dt
    }
    this._flightVel += (target - this._flightVel) * (1 - Math.exp(-dt / FLY_TAU));
    if (Math.abs(this._flightVel) < 1e-5 * mass && this._flight === 0) this._flightVel = 0;
    if (this._flightVel === 0) return;
    const next = Math.min(hi, Math.max(lo, distance + this._flightVel * dt));
    // Hitting a limit kills the velocity so releasing the key does not keep pushing into the wall.
    if (next === lo && this._flightVel < 0) this._flightVel = 0;
    if (next === hi && this._flightVel > 0) this._flightVel = 0;
    this.camera.position.setLength(next);
  }

  _setMass(mass) {
    if (mass === this._mass) return;
    this._mass = mass;
    this._applyLimits(mass);
    const d = this.camera.position.length();
    const clamped = Math.min(MAX_DISTANCE_M * mass, Math.max(MIN_DISTANCE_RS * 2 * mass, d));
    if (clamped !== d) {
      this.camera.position.setLength(clamped);
      this.camera.updateMatrixWorld();
    }
    this._prevDistance = null; // a mass-driven clamp is not a motion
  }

  _applyLimits(mass) {
    this.controls.minDistance = MIN_DISTANCE_RS * 2 * mass;
    this.controls.maxDistance = MAX_DISTANCE_M * mass;
  }

  _place(distance, inclinationDeg, azimuthDeg) {
    const mass = this._mass;
    const d = Math.min(MAX_DISTANCE_M * mass, Math.max(MIN_DISTANCE_RS * 2 * mass, distance));
    const inc = Math.min(Math.PI - POLAR_EPS, Math.max(POLAR_EPS, inclinationDeg * DEG));
    const az = azimuthDeg * DEG;
    const s = Math.sin(inc);
    this.camera.position.set(d * s * Math.sin(az), d * Math.cos(inc), d * s * Math.cos(az));
    this.controls.target.set(0, 0, 0);
    this.camera.lookAt(this.controls.target);
    this.camera.updateMatrixWorld();
  }

  // Discard pending drag inertia: with damping off, update() applies the remaining delta and clears it.
  _flushControls() {
    const controls = this.controls;
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
    this.camera.updateMatrixWorld();
  }
}
