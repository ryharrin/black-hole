// Scripted cinematic camera path. Pure functions, no DOM / three imports (safe in browser and node).
//
// Pose = { distance, inclinationDeg, azimuthDeg }, same spherical convention as the rest of the sim:
// inclination measured from the +y pole (90 = edge-on), azimuth 0 = +z, increasing toward +x.
//
// The path is a periodic, uniformly-parameterised Catmull-Rom spline over keyframes. Distance is
// interpolated in log space (so the dive feels even), azimuth is unwrapped (it gains exactly 360 over
// one loop so the path closes). Keyframes are expressed in units of M and scale with `mass`.

export const CINEMATIC_PERIOD = 90; // seconds per loop
export const EINSTEIN_TIME = 30; // seconds into the loop at which the Einstein-star alignment occurs

// [distance / M, inclinationDeg, unwrapped azimuthDeg]; 12 keys, 7.5 s apart.
const KEYS = [
  [50, 72, 180], //  0.0 s  wide establishing orbit
  [46, 66, 235], //  7.5
  [40, 75, 290], // 15.0
  [32, 80, 340], // 22.5  settling into the alignment
  [30, 80, 360], // 30.0  EINSTEIN: inclination 80, azimuth 0 (mod 360), distance 30M -> full ring
  [31, 80, 380], // 37.5  drifting off axis, ring breaks into arcs
  [22, 85, 410], // 45.0  start of dive
  [12, 88, 450], // 52.5
  [6, 82, 480], //  60.0  slow dive to ~3 rs (rs = 2M)
  [14, 70, 505], // 67.5  pull back
  [34, 60, 522], // 75.0
  [52, 66, 532], // 82.5
]; // wraps to key 0 with azimuth 180 + 360 = 540

const N = KEYS.length;
const SEG = CINEMATIC_PERIOD / N;
const LOG_D = KEYS.map((k) => Math.log(k[0]));

function key(i) {
  const k = ((i % N) + N) % N;
  const wraps = (i - k) / N;
  return [LOG_D[k], KEYS[k][1], KEYS[k][2] + 360 * wraps];
}

// Uniform Catmull-Rom (tension 0.5) on one scalar.
function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/**
 * Camera pose at time t (seconds, any real; wraps every CINEMATIC_PERIOD) for a hole of the given mass.
 * Distances are clamped to [1.05 rs, 80 M].
 */
export function cinematicPose(t, mass = 1) {
  const s = (((t % CINEMATIC_PERIOD) + CINEMATIC_PERIOD) % CINEMATIC_PERIOD) / SEG;
  const i = Math.floor(s);
  const u = s - i;
  const a = key(i - 1);
  const b = key(i);
  const c = key(i + 1);
  const d = key(i + 2);
  const distance = Math.exp(catmull(a[0], b[0], c[0], d[0], u)) * mass;
  const inclinationDeg = catmull(a[1], b[1], c[1], d[1], u);
  const azimuthDeg = catmull(a[2], b[2], c[2], d[2], u);
  return {
    distance: Math.min(80 * mass, Math.max(2.1 * mass, distance)),
    inclinationDeg: Math.min(179, Math.max(1, inclinationDeg)),
    azimuthDeg: ((azimuthDeg % 360) + 360) % 360,
  };
}

const unit = (inclinationDeg, azimuthDeg) => {
  const inc = (inclinationDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  return [Math.sin(inc) * Math.sin(az), Math.cos(inc), Math.sin(inc) * Math.cos(az)];
};

/**
 * Loop phase (seconds in [0, CINEMATIC_PERIOD)) whose pose is closest to `pose`: great-circle angle of the
 * view direction plus 40 deg per e-fold of distance ratio. Used so entering cinematic joins the path near
 * where the camera already is instead of swinging to the start of the loop.
 */
export function nearestCinematicPhase(pose, mass = 1, step = 0.25) {
  const a = unit(pose.inclinationDeg, pose.azimuthDeg);
  const logD = Math.log(Math.max(pose.distance, 1e-9));
  let best = 0;
  let bestCost = Infinity;
  for (let t = 0; t < CINEMATIC_PERIOD; t += step) {
    const p = cinematicPose(t, mass);
    const b = unit(p.inclinationDeg, p.azimuthDeg);
    const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const cost = (Math.acos(dot) * 180) / Math.PI + 40 * Math.abs(Math.log(p.distance) - logD);
    if (cost < bestCost) {
      bestCost = cost;
      best = t;
    }
  }
  return best;
}
