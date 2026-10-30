// Traces the light ray a screen pixel sees, backwards from the camera, with the same integrator and
// step rule as the GLSL ray-marcher (units of M, horizon at r = 2). A probe released on this ray
// appears exactly under the pixel, lensing included.

/**
 * Point (units of M) on the pixel's light ray where a clicked probe should be released: the first of
 *  - just in front of the accretion disk, if the ray hits it (`diskClearance` back along the ray),
 *  - the release floor `minRadius`, if the ray falls toward the shadow,
 *  - the plane through the hole facing the camera (`dot(x, forward) = 0`).
 * @param {object} o
 * @param {number[]} o.origin camera position
 * @param {number[]} o.direction unit direction of the pixel's view ray
 * @param {number[]} o.forward unit camera forward (the release plane's normal)
 * @param {number} o.bend lensing strength; 0 for straight rays
 * @param {number} o.spin dimensionless spin (frame-dragging term, as in the shader)
 * @param {number[]} o.diskAxis unit disk normal
 * @param {boolean} o.disk whether the disk is drawn
 * @param {number} o.innerRadius disk inner edge
 * @param {number} [o.outerRadius=20] disk outer edge
 * @param {number} o.minRadius closest release radius
 * @param {number} [o.diskClearance=0.8] gap kept in front of the disk
 * @returns {number[]} release point
 */
export function photonReleasePoint({ origin, direction, forward, bend, spin, diskAxis, disk, innerRadius, outerRadius = 20, minRadius, diskClearance = 0.8 }) {
  let p = [...origin];
  let v = [...direction];
  const L = cross(p, v);
  const h2 = dot(L, L);
  let a = acceleration(p, v, h2, bend, spin, diskAxis);
  for (let step = 0; step < 180; step++) {
    const radius = norm(p);
    const stepSize = bend > 0 ? clamp((radius - 1.8) * 0.3, 0.15, 8) : 4;
    const next = p.map((x, i) => x + v[i] * stepSize + 0.5 * a[i] * stepSize * stepSize);
    const nextA = acceleration(next, v, h2, bend, spin, diskAxis);
    const nextV = v.map((x, i) => x + 0.5 * (a[i] + nextA[i]) * stepSize);
    const segment = next.map((x, i) => x - p[i]);

    let best = Infinity;
    let release = null;
    const floorT = sphereEntry(p, segment, minRadius);
    if (floorT < best) { best = floorT; release = lerp(p, segment, floorT); }
    const s0 = dot(p, forward), s1 = dot(next, forward);
    if (s0 < 0 && s1 >= 0) {
      const t = -s0 / (s1 - s0);
      if (t < best) { best = t; release = lerp(p, segment, t); }
    }
    const y0 = dot(p, diskAxis), y1 = dot(next, diskAxis);
    if (disk && y0 * y1 < 0) {
      const t = -y0 / (y1 - y0);
      const hit = lerp(p, segment, t);
      const r = norm(hit);
      if (r >= innerRadius && r <= outerRadius && t < best) {
        best = t;
        const back = normalize(segment);
        release = hit.map((x, i) => x - back[i] * diskClearance);
      }
    }
    if (release) return release;
    if (norm(next) > 55 && dot(next, nextV) > 0) return next;
    p = next; v = nextV; a = nextA;
  }
  return p;
}

function acceleration(p, v, h2, bend, spin, axis) {
  if (!(bend > 0)) return [0, 0, 0];
  const r2 = dot(p, p), r = Math.sqrt(r2);
  const k = -3 * h2 / (r2 * r2 * r);
  const ap = dot(axis, p);
  const field = axis.map((x, i) => x - 3 * ap * p[i] / r2);
  const drag = cross(v, field);
  const d = 0.16 * spin / (r2 * r);
  return p.map((x, i) => bend * (k * x + d * drag[i]));
}
/** Smallest t in [0, 1] where |p + t·s| first drops to radius, or Infinity. */
function sphereEntry(p, s, radius) {
  const ss = dot(s, s), ps = dot(p, s), c = dot(p, p) - radius * radius;
  if (c <= 0) return 0;
  const disc = ps * ps - ss * c;
  if (disc < 0) return Infinity;
  const t = (-ps - Math.sqrt(disc)) / ss;
  return t >= 0 && t <= 1 ? t : Infinity;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => { const n = norm(a); return a.map((x) => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (p, s, t) => p.map((x, i) => x + s[i] * t);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
