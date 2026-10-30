export const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 cameraPositionWorld;
uniform mat3 cameraRotation;
uniform mat3 worldToDisk;
uniform float aspect, tanHalfFov, simTime, mass, spin, diskTemp, innerRadius;
uniform float lensingStrength, starStretch, pixelAngle;
uniform vec3 einsteinStarDir;
uniform bool lensing, doppler, stars, disk;
uniform int maxSteps, bodyCount;
uniform vec4 bodyA[16];
uniform vec4 bodyB[16];
uniform vec4 bodyC[16];
uniform vec4 bodyD[16];
const float PI = 3.141592653589793;

float hash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  return 0.57 * noise(p) + 0.28 * noise(p * 2.03 + 7.1) + 0.15 * noise(p * 4.11 + 13.7);
}
float filteredFbm(vec3 p, float footprint) {
  float value = 0.5, amplitude = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    float resolved = 1.0 - smoothstep(0.25, 0.85, footprint);
    value += amplitude * (noise(p) - 0.5) * resolved;
    p = p * 2.03 + 7.1;
    footprint *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 255.0 : 329.698727446 * pow(t - 60.0, -0.1332047592);
  c.g = t <= 66.0 ? 99.4708025861 * log(t) - 161.1195681661 : 288.1221695283 * pow(t - 60.0, -0.0755148492);
  c.b = t >= 66.0 ? 255.0 : (t <= 19.0 ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307);
  c = clamp(c / 255.0, 0.0, 1.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 starCell(vec2 grid, vec2 cell, float face, vec2 radial) {
  vec3 seed = vec3(cell, face * 19.0);
  vec2 point = vec2(hash(seed + 2.1), hash(seed + 7.7)) * 0.6 + 0.2;
  vec2 offset = grid - cell - point;
  offset -= radial * dot(offset, radial) * (1.0 - 1.0 / starStretch);
  float star = (1.0 - smoothstep(0.015, 0.18, length(offset))) * step(0.982, hash(seed));
  float brightness = 0.35 + 3.5 * pow(hash(seed + 19.3), 6.0);
  vec3 tint = mix(vec3(0.5, 0.67, 1.0), vec3(1.0, 0.79, 0.53), hash(seed + 12.4));
  return tint * star * brightness;
}
vec3 background(vec3 direction) {
  if (!stars) return vec3(0.0);
  vec3 d = normalize(direction), ad = abs(d);
  vec2 uv;
  float face;
  if (ad.x > ad.y && ad.x > ad.z) { uv = d.yz / ad.x; face = d.x > 0.0 ? 1.0 : 2.0; }
  else if (ad.y > ad.z) { uv = d.xz / ad.y; face = d.y > 0.0 ? 3.0 : 4.0; }
  else { uv = d.xy / ad.z; face = d.z > 0.0 ? 5.0 : 6.0; }
  vec2 grid = uv * 220.0, cell = floor(grid);
  // Pull the screen-radial direction through the lensed cube-map Jacobian.
  vec2 radial = normalize(dFdx(uv) * (vUv.x - 0.5) * aspect + dFdy(uv) * (vUv.y - 0.5) + vec2(1e-7));
  vec3 starColor = starCell(grid, cell, face, radial);
  if (starStretch > 1.2) {
    // Neighbor cells retain the ends of streaks instead of clipping them at cell edges.
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        if (x != 0 || y != 0) starColor += starCell(grid, cell + vec2(float(x), float(y)), face, radial);
      }
    }
  }
  float latitude = dot(d, normalize(vec3(0.3, 0.8, -0.4)));
  float cloud = fbm(d * 19.0);
  float dust = smoothstep(0.28, 0.7, fbm(d * 45.0 + 8.0));
  float band = exp(-latitude * latitude * 65.0) * cloud * dust;
  // A 0.04-degree Gaussian star convolved with the pixel's angular covariance.
  // Unlike fwidth(length(offset)), this filter has no cardinal-direction cusps.
  vec3 sourceY = normalize(cross(einsteinStarDir, vec3(1.0, 0.0, 0.0)));
  vec2 q = vec2(d.x, dot(d, sourceY));
  vec2 dx = dFdx(q), dy = dFdy(q);
  float variance = 0.0003 * 0.0003;
  float xx = variance + (dx.x * dx.x + dy.x * dy.x) / 12.0;
  float yy = variance + (dx.y * dx.y + dy.y * dy.y) / 12.0;
  float xy = (dx.x * dx.y + dy.x * dy.y) / 12.0;
  float determinant = max(variance * variance, xx * yy - xy * xy);
  float distance2 = (yy * q.x * q.x - 2.0 * xy * q.x * q.y + xx * q.y * q.y) / determinant;
  float einstein = exp(-0.5 * max(0.0, distance2)) * variance / sqrt(determinant) * step(0.0, dot(d, einsteinStarDir));
  return starColor + vec3(0.07, 0.085, 0.13) * band
       + vec3(0.85, 0.92, 1.0) * einstein * 2.5 + vec3(0.0003, 0.0005, 0.001);
}
float diskTexture(float r, float angle, float age, float seed, float rayFootprint) {
  float denominator = r * sqrt(r) + spin;
  float phase = angle + age / denominator + 1.6 * log(r / innerRadius);
  vec3 flow = vec3(r * 0.9, cos(phase) * 5.0, sin(phase) * 5.0) + vec3(0.0, seed * 13.7, seed * 7.9);
  float phaseGradient = -1.5 * age * sqrt(r) / (denominator * denominator) + 1.6 / r;
  float footprint = rayFootprint * max(0.9, 5.0 * max(abs(phaseGradient), 1.0 / r));
  float warpResolved = 1.0 - smoothstep(0.25, 0.85, footprint * 0.55);
  vec3 warp = (vec3(noise(flow * 0.55), noise(flow * 0.55 + 17.3), noise(flow * 0.55 + 31.7)) - 0.5) * warpResolved;
  vec3 turbulentFlow = flow + 2.4 * warp;
  float turbulence = filteredFbm(turbulentFlow * 1.7, footprint * 2.7);
  float filaments = smoothstep(0.30, 0.72, turbulence);
  float lanes = smoothstep(0.25, 0.50, filteredFbm(turbulentFlow * 0.6 + 9.1, footprint));
  return 0.10 + 1.8 * filaments * lanes;
}
vec4 diskEmission(vec3 hit, vec3 rayDirection, float rayFootprint) {
  float r = length(hit.xz), angle = atan(hit.z, hit.x);
  // Finite-lived eddies advect at Omega, then renew invisibly as their crossfade reaches zero.
  // Without renewal, differential rotation winds any frozen texture into concentric stripes.
  float cycle = simTime / (mass * 40.0);
  float ageA = fract(cycle), ageB = fract(cycle + 0.5);
  float blend = pow(sin(PI * ageA), 2.0);
  float textureA = diskTexture(r, angle, ageA * 40.0, floor(cycle), rayFootprint);
  float textureB = diskTexture(r, angle, ageB * 40.0, floor(cycle + 0.5) + 37.0, rayFootprint);
  float edge = smoothstep(innerRadius, innerRadius + 0.45, r) * (1.0 - smoothstep(16.0, 20.0, r));
  float heat = pow(innerRadius / r, 2.1);
  float innerGlow = 0.3 * exp(-pow((r - innerRadius - 0.45) / 0.8, 2.0));
  float density = mix(textureB, textureA, blend) + innerGlow;
  float g = 1.0;
  if (doppler) {
    float beta = r > 3.0 ? min(0.999, sqrt(1.0 / (r - 2.0))) : 0.999;
    vec3 tangent = vec3(hit.z, 0.0, -hit.x) / r;
    float cosTheta = dot(tangent, -normalize(rayDirection));
    g = sqrt(max(0.0, 1.0 - 2.0 / r)) * sqrt(1.0 - beta * beta) / (1.0 - beta * cosTheta);
  }
  float temperature = diskTemp * pow(innerRadius / r, 0.75) * g;
  float opacity = mix(0.999, 0.98, smoothstep(innerRadius + 2.0, 20.0, r)) * edge;
  return vec4(blackbody(temperature) * (3.2 * heat * edge * density * pow(g, 4.0)), opacity);
}
// ---------------------------------------------------------------------------------------------
// Bodies: probe spacecraft (SDF), stars, planets. Local ship frame: +x nose, +y up, +z starboard,
// half-length 1.
float sdCapsuleX(vec3 p, float x0, float x1, float r) {
  p.x -= clamp(p.x, x0, x1);
  return length(p) - r;
}
float sdRoundConeX(vec3 p, float x0, float r1, float x1, float r2) {
  float h = x1 - x0;
  float b = (r1 - r2) / h;
  float a = sqrt(max(0.0, 1.0 - b * b));
  vec2 q = vec2(length(p.yz), p.x - x0);
  float k = dot(q, vec2(-b, a));
  if (k < 0.0) return length(q) - r1;
  if (k > a * h) return length(q - vec2(0.0, h)) - r2;
  return dot(q, vec2(a, b)) - r1;
}
float sdSeg(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
const vec3 DISH_N = vec3(0.3303, 0.9438, 0.0);
const vec3 DISH_RIM = vec3(-0.05, 0.66, 0.0);
const float PANEL_C = 0.9211, PANEL_S = 0.3894;
vec3 panelCoords(vec3 p) {
  vec3 pp = vec3(p.x + 0.05, p.y, abs(p.z) - 1.14);
  return vec3(PANEL_C * pp.x - PANEL_S * pp.y, PANEL_S * pp.x + PANEL_C * pp.y, pp.z);
}
// x: distance, y: material id (0 bus foil, 1 nose, 2 bell, 3 dish, 4 panel, 5 strut, 6 nav light, 7 engine core)
vec2 shipMap(vec3 p) {
  vec2 res = vec2(sdCapsuleX(p, -0.35, 0.28, 0.30), 0.0);
  float d = sdRoundConeX(p, 0.28, 0.27, 0.98, 0.035);
  if (d < res.x) res = vec2(d, 1.0);
  d = max(sdRoundConeX(p, -1.0, 0.22, -0.62, 0.13), -sdRoundConeX(p, -1.06, 0.20, -0.70, 0.08));
  if (d < res.x) res = vec2(d, 2.0);
  d = max(abs(p.x + 0.76) - 0.012, length(p.yz) - 0.088);
  if (d < res.x) res = vec2(d, 7.0);
  // Collar and mast.
  d = max(abs(p.x - 0.18) - 0.045, length(p.yz) - 0.322);
  if (d < res.x) res = vec2(d, 5.0);
  d = sdSeg(p, vec3(-0.05, 0.25, 0.0), vec3(-0.05, 0.60, 0.0), 0.026);
  if (d < res.x) res = vec2(d, 5.0);
  // High-gain dish: concave shell opening toward +DISH_N plus feed horn.
  vec3 dishCenter = DISH_RIM + DISH_N * 0.398;
  d = max(abs(length(p - dishCenter) - 0.55) - 0.010, dot(p - DISH_RIM, DISH_N));
  if (d < res.x) res = vec2(d, 3.0);
  d = min(sdSeg(p, DISH_RIM - DISH_N * 0.13, DISH_RIM + DISH_N * 0.36, 0.011), length(p - (DISH_RIM + DISH_N * 0.38)) - 0.032);
  if (d < res.x) res = vec2(d, 5.0);
  // Magnetometer boom.
  d = min(sdSeg(p, vec3(-0.05, -0.26, 0.0), vec3(0.12, -0.86, -0.24), 0.016), length(p - vec3(0.12, -0.86, -0.24)) - 0.05);
  if (d < res.x) res = vec2(d, 5.0);
  // Mirrored solar wings, tilted about the span axis.
  vec3 pz = vec3(p.x + 0.05, p.y, abs(p.z));
  d = sdSeg(pz, vec3(0.0, 0.0, 0.25), vec3(0.0, 0.0, 0.64), 0.03);
  if (d < res.x) res = vec2(d, 5.0);
  vec3 pc = panelCoords(p);
  vec3 bq = abs(pc) - vec3(0.30, 0.012, 0.52);
  d = length(max(bq, 0.0)) + min(max(bq.x, max(bq.y, bq.z)), 0.0) - 0.004;
  if (d < res.x) res = vec2(d, 4.0);
  d = length(pz - vec3(0.0, 0.0, 1.70)) - 0.055;
  if (d < res.x) res = vec2(d, 6.0);
  return res;
}
vec3 shipNormal(vec3 p, float e) {
  vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * shipMap(p + k.xyy * e).x + k.yyx * shipMap(p + k.yyx * e).x
                 + k.yxy * shipMap(p + k.yxy * e).x + k.xxx * shipMap(p + k.xxx * e).x);
}
// rgb: emission + reflected light (premultiplied), a: opacity of the solid hull.
vec4 shipColor(vec3 E, vec3 dir, float chord, float R, float fpR, float g, float parity, vec3 forward, vec3 Lw, vec3 keyCol) {
  vec3 refUp = abs(forward.y) > 0.92 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 rt = normalize(cross(forward, refUp));
  vec3 up = cross(rt, forward);
  mat3 B = mat3(forward, up, rt);
  vec3 ro = (E / R) * B, rd = dir * B, Ll = Lw * B;
  float chordR = chord / R;
  float eps = max(0.0016, 0.45 * fpR);
  float t = 0.0, id = -1.0;
  for (int i = 0; i < 24; i++) {
    vec2 h = shipMap(ro + rd * t);
    if (h.x < eps) { id = h.y; break; }
    t += h.x;
    if (t > chordR) break;
  }
  float g3 = g * g * g, g4 = g3 * g;
  float tEnd = id >= 0.0 ? t : chordR;
  float ph = fract(simTime * 0.09 + parity * 0.5);
  float redOn = 0.2 + 0.8 * smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.45, 0.5, ph));
  float greenOn = 0.2 + 0.8 * smoothstep(0.5, 0.55, ph) * (1.0 - smoothstep(0.95, 1.0, ph));
  vec3 col = vec3(0.0);
  float opaque = 0.0;
  if (id >= 0.0) {
    opaque = 1.0;
    vec3 hp = ro + rd * t;
    vec3 n = shipNormal(hp, clamp(0.4 * fpR, 0.003, 0.03));
    vec3 V = -rd;
    int m = int(id + 0.5);
    vec3 alb = vec3(0.5);
    vec3 specCol = vec3(1.0);
    float shin = 24.0, spec = 0.25;
    vec3 emis = vec3(0.0);
    if (m == 0) {
      vec3 w = hp * 12.0;
      float fade = 1.0 - smoothstep(0.3, 0.9, fpR * 12.0);
      vec3 crinkle = (vec3(noise(w), noise(w + 5.2), noise(w + 9.1)) - 0.5) * 1.1 * fade;
      n = normalize(n + crinkle);
      float tone = 0.78 + 0.5 * (noise(hp * 5.0 + 3.0) - 0.5) + 0.25 * crinkle.x;
      alb = pow(vec3(0.95, 0.66, 0.22), vec3(2.2)) * tone;
      float band = (smoothstep(0.0, 0.015, abs(hp.x - 0.05) - 0.03) < 0.5 || smoothstep(0.0, 0.015, abs(hp.x + 0.25) - 0.014) < 0.5) ? 1.0 : 0.0;
      alb = mix(alb, vec3(0.025, 0.025, 0.03), band * 0.85);
      specCol = pow(vec3(0.95, 0.7, 0.3), vec3(2.2)); shin = 48.0; spec = 1.2;
    } else if (m == 1) {
      float seam = 1.0 - smoothstep(0.0, 0.012 + fpR, abs(fract(hp.x * 7.0) - 0.5) - 0.46);
      alb = vec3(0.62, 0.64, 0.68) * (1.0 - 0.45 * seam);
      shin = 36.0; spec = 0.35;
    } else if (m == 2) {
      alb = vec3(0.05, 0.05, 0.06); shin = 40.0; spec = 0.8;
      emis = vec3(0.12, 0.3, 0.9) * smoothstep(-0.75, -1.02, hp.x) * 0.9;
    } else if (m == 3) {
      alb = vec3(0.7, 0.72, 0.75); shin = 70.0; spec = 0.55;
      alb *= 0.9 + 0.1 * smoothstep(0.0, 0.02, abs(fract(length(hp - (DISH_RIM + DISH_N * 0.398)) * 22.0) - 0.5) - 0.40);
    } else if (m == 4) {
      vec3 pc = panelCoords(hp);
      vec2 uv = vec2(pc.x / 0.60 + 0.5, (pc.z + 0.52) / 1.04);
      float face = dot(n, vec3(PANEL_S, PANEL_C, 0.0));
      float edge = max(abs(uv.x - 0.5) * 2.0, abs(uv.y - 0.5) * 2.0);
      vec2 cell = abs(fract(uv * vec2(6.0, 11.0)) - 0.5);
      float seam = smoothstep(0.42, 0.5, max(cell.x, cell.y)) * (1.0 - smoothstep(0.4, 1.0, fpR * 11.0));
      float cellTone = 0.6 + 0.8 * hash(vec3(floor(uv * vec2(6.0, 11.0)), 1.0));
      if (face > 0.35 && edge < 0.93) {
        alb = mix(pow(vec3(0.08, 0.12, 0.38), vec3(2.2)) * cellTone, vec3(0.30, 0.32, 0.36), seam);
        specCol = vec3(0.45, 0.65, 1.0); shin = 90.0; spec = 1.6;
      } else if (face < -0.35) {
        alb = vec3(0.27, 0.28, 0.30); shin = 20.0; spec = 0.15;
      } else {
        alb = pow(vec3(0.85, 0.62, 0.25), vec3(2.2)); specCol = alb; shin = 30.0; spec = 0.6;
      }
    } else if (m == 5) {
      alb = vec3(0.42, 0.43, 0.46); shin = 30.0; spec = 0.4;
    } else if (m == 6) {
      float on = hp.z > 0.0 ? greenOn : redOn;
      vec3 lc = hp.z > 0.0 ? vec3(0.1, 1.0, 0.25) : vec3(1.0, 0.07, 0.04);
      alb = vec3(0.02); emis = lc * on * 4.5;
    } else {
      alb = vec3(0.0); emis = vec3(0.55, 0.8, 1.0) * 6.0;
    }
    float nl = dot(n, Ll);
    float diff = max(nl, 0.0);
    vec3 H = normalize(Ll + V);
    float sp = pow(max(dot(n, H), 0.0), shin) * spec * step(0.0, nl);
    float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    vec3 ambient = vec3(0.07, 0.09, 0.15) * (0.55 + 0.45 * n.y) * g3;
    vec3 fillDir = normalize(V * 0.7 + vec3(0.0, 0.6, 0.0));
    vec3 fill = keyCol * vec3(0.45, 0.55, 0.8) * (0.35 * max(dot(n, fillDir), 0.0));
    col = alb * (keyCol * diff + fill + ambient) + keyCol * specCol * sp + emis * g4;
    col += vec3(0.5, 0.7, 1.0) * rim * 0.07 * g3 * (0.5 + diff);
  }
  // Engine exhaust plume: a few jittered samples along the occluded chord.
  float jitter = hash(vec3(gl_FragCoord.xy, 1.7));
  float dtp = tEnd / 10.0;
  float acc = 0.0;
  for (int k = 0; k < 10; k++) {
    vec3 pp = ro + rd * ((float(k) + jitter) * dtp);
    float len = -1.0 - pp.x;
    if (len > -0.08 && len < 0.8) {
      float L = max(len, 0.0);
      float w = 0.085 + 0.1 * L;
      float rho2 = dot(pp.yz, pp.yz);
      float flick = 0.8 + 0.4 * noise(vec3(L * 16.0 - simTime * 2.5, pp.y * 9.0, pp.z * 9.0));
      acc += exp(-rho2 / (w * w)) * exp(-L * 3.4) * smoothstep(-0.08, 0.0, len) * flick * dtp;
    }
  }
  col += blackbody(10500.0 * g) * (acc * 14.0 * g4);
  // Nav light halos.
  for (int s = 0; s < 2; s++) {
    float sgn = s == 0 ? 1.0 : -1.0;
    vec3 w = ro - vec3(-0.05, 0.0, sgn * 1.70);
    float tc = clamp(-dot(w, rd), 0.0, tEnd);
    vec3 dv = w + rd * tc;
    float halo = exp(-dot(dv, dv) / 0.0036);
    col += (s == 0 ? vec3(0.1, 1.0, 0.25) * greenOn : vec3(1.0, 0.07, 0.04) * redOn) * halo * 0.7 * g4;
  }
  return vec4(col, opaque);
}
float starLuminosity(float T0) {
  return 5.0 * clamp(pow(T0 / 5800.0, 1.3), 0.45, 3.0);
}
vec3 starSurface(vec3 n, float mu, float T0, float g, float seed, float fpR) {
  float ph = simTime * 0.02;
  float c = cos(ph), s = sin(ph);
  vec3 nl = vec3(c * n.x - s * n.z, n.y, s * n.x + c * n.z) + vec3(seed * 3.17, seed * 1.31, seed * 2.03);
  float gran = filteredFbm(nl * 14.0 + vec3(0.0, 0.0, simTime * 0.05), fpR * 14.0);
  float spots = smoothstep(0.58, 0.68, filteredFbm(nl * 2.4 + 5.0, fpR * 2.4));
  float ld = 0.28 + 0.72 * pow(mu, 0.7);
  float T = T0 * g * (0.86 + 0.14 * mu - 0.22 * spots);
  return blackbody(T) * (starLuminosity(T0) * ld * (0.72 + 0.5 * gran) * (1.0 - 0.6 * spots) * pow(g, 4.0));
}
vec3 planetAxis(float seed) {
  float tilt = 0.25 + 0.7 * fract(seed * 0.37), az = 6.2832 * fract(seed * 0.73);
  return vec3(sin(tilt) * cos(az), cos(tilt), sin(tilt) * sin(az));
}
vec3 planetSurface(vec3 n, vec3 V, float style, float seed, float g, vec3 Lw, vec3 keyCol, float fpR, bool ringed, vec3 ey) {
  vec3 ex = normalize(cross(ey, abs(ey.x) < 0.8 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
  vec3 ez = cross(ex, ey);
  float ph = simTime * (0.010 + 0.008 * fract(seed * 0.31));
  float cp = cos(ph), sp = sin(ph);
  vec3 nl = vec3(dot(n, ex), dot(n, ey), dot(n, ez));
  nl = vec3(cp * nl.x - sp * nl.z, nl.y, sp * nl.x + cp * nl.z);
  float lat = nl.y;
  float nL = dot(n, Lw);
  float lit = smoothstep(-0.12, 0.45, nL);
  vec3 alb = vec3(0.5), rimCol = vec3(0.4, 0.6, 1.0);
  float ocean = 0.0;
  int st = int(style + 0.5);
  if (st == 0) {
    float pick = floor(fract(seed * 0.131) * 3.0);
    vec3 cA = pick < 0.5 ? vec3(0.78, 0.62, 0.42) : (pick < 1.5 ? vec3(0.35, 0.55, 0.85) : vec3(0.85, 0.75, 0.5));
    vec3 cB = pick < 0.5 ? vec3(0.45, 0.26, 0.15) : (pick < 1.5 ? vec3(0.13, 0.26, 0.55) : vec3(0.55, 0.43, 0.28));
    vec3 cC = pick < 0.5 ? vec3(0.93, 0.85, 0.68) : (pick < 1.5 ? vec3(0.65, 0.8, 0.95) : vec3(0.95, 0.9, 0.75));
    float turb = filteredFbm(vec3(nl.x * 3.0, lat * 9.0, nl.z * 3.0) + seed * 3.7, fpR * 9.0);
    float bands = 0.5 + 0.5 * sin(lat * 10.5 + (turb - 0.5) * 6.0 + seed);
    float fine = 0.5 + 0.5 * sin(lat * 31.0 + (turb - 0.5) * 9.0);
    vec3 c = mix(cB, cA, smoothstep(0.2, 0.8, bands));
    c = mix(c, cC, smoothstep(0.55, 0.95, fine) * 0.45);
    alb = pow(c * (0.78 + 0.45 * turb), vec3(2.2));
    vec3 stormDir = normalize(vec3(cos(seed * 2.3), -0.32, sin(seed * 2.3)));
    vec3 dv = nl - stormDir;
    float storm = 1.0 - smoothstep(0.10, 0.24, length(vec3(dv.x, dv.y * 2.6, dv.z)));
    alb = mix(alb, pow(vec3(0.82, 0.38, 0.22), vec3(2.2)), storm * 0.85);
    rimCol = pow(cC, vec3(2.2)) * vec3(0.9, 0.95, 1.0);
  } else if (st == 1) {
    float h = filteredFbm(nl * 2.6 + seed * 1.7, fpR * 2.6);
    vec3 deep = pow(vec3(0.02, 0.10, 0.32), vec3(2.2)), shallow = pow(vec3(0.08, 0.34, 0.52), vec3(2.2));
    vec3 low = pow(vec3(0.2, 0.42, 0.16), vec3(2.2)), high = pow(vec3(0.5, 0.4, 0.28), vec3(2.2));
    vec3 c = h < 0.5 ? mix(deep, shallow, smoothstep(0.30, 0.5, h)) : mix(low, high, smoothstep(0.52, 0.72, h));
    ocean = h < 0.5 ? 1.0 : 0.0;
    float cap = smoothstep(0.78, 0.9, abs(lat) + 0.14 * (h - 0.5));
    c = mix(c, vec3(0.82, 0.88, 0.92), cap);
    ocean *= 1.0 - cap;
    float cloud = smoothstep(0.52, 0.72, filteredFbm(nl * 4.5 + vec3(0.0, 0.0, simTime * 0.008) + 9.0, fpR * 4.5));
    c = mix(c, vec3(0.9), cloud * 0.9);
    ocean *= 1.0 - cloud;
    alb = c;
    rimCol = vec3(0.3, 0.55, 1.0);
  } else {
    float c1 = filteredFbm(nl * 3.2 + seed, fpR * 3.2);
    float crack = (1.0 - smoothstep(0.0, 0.03, abs(c1 - 0.5))) * (1.0 - smoothstep(0.15, 0.5, fpR * 3.2));
    float mott = filteredFbm(nl * 8.0 + 4.0, fpR * 8.0);
    vec3 base = pow(vec3(0.72, 0.84, 0.93), vec3(2.2)) * (0.75 + 0.5 * mott);
    alb = mix(base, pow(vec3(0.3, 0.5, 0.75), vec3(2.2)), crack * 0.75);
    ocean = 0.35;
    rimCol = vec3(0.55, 0.8, 1.0);
  }
  float ringShade = 1.0;
  if (ringed) {
    float den = dot(Lw, ey);
    float s = -dot(n, ey) / (abs(den) > 1e-4 ? den : 1e-4);
    float rr = length(n + s * Lw);
    ringShade = (s > 0.0 && rr > 1.38 && rr < 2.2) ? 0.45 : 1.0;
  }
  float g3 = g * g * g;
  vec3 col = alb * (keyCol * lit * ringShade + vec3(0.05, 0.06, 0.09) * g3);
  vec3 H = normalize(Lw + V);
  col += keyCol * pow(max(dot(n, H), 0.0), 80.0) * ocean * lit * 0.7;
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col += rimCol * keyCol * fres * (0.08 + 0.9 * smoothstep(-0.35, 0.5, nL)) * 0.9;
  return col;
}
// rgb: premultiplied by coverage, a: total opacity of planet + ring over what lies behind.
vec4 planetShade(vec3 q, vec3 sg, float ss, float qs, float qq, float R, bool ringed, float style, float seed, float g, vec3 Lw, vec3 keyCol, float fpM, float horizonFraction) {
  float tc = -qs / ss;
  float rho2 = max(0.0, qq - qs * qs / ss);
  float disc2 = qs * qs - ss * (qq - R * R);
  float tp = disc2 >= 0.0 ? tc - sqrt(disc2) / ss : tc;
  float cover = clamp((R - sqrt(rho2)) / fpM + 0.5, 0.0, 1.0);
  if (tp >= horizonFraction || tp < 0.0 || tp > 1.0) cover = 0.0;
  vec3 ey = planetAxis(seed);
  vec3 dirT = sg * inversesqrt(ss);
  float fpR = fpM / R;
  float ringA = 0.0, tRing = 1e9;
  vec3 ringC = vec3(0.0);
  if (ringed) {
    float den = dot(sg, ey);
    float tr = abs(den) > 1e-6 ? -dot(q, ey) / den : -1.0;
    vec3 P = q + tr * sg;
    float rr = length(P) / R;
    if (tr >= 0.0 && tr <= 1.0 && tr < horizonFraction && rr > 1.35 && rr < 2.3) {
      float bandN = filteredFbm(vec3(rr * 17.0, seed, 3.0), fpR * 17.0);
      float gap = 1.0 - (1.0 - smoothstep(0.0, 0.045, abs(rr - 1.88)));
      ringA = 0.78 * smoothstep(0.22, 0.62, bandN) * smoothstep(1.35, 1.45, rr) * (1.0 - smoothstep(2.12, 2.3, rr)) * gap;
      float Ls = dot(P, Lw);
      float shadow = Ls < 0.0 ? smoothstep(0.96 * R, 1.04 * R, sqrt(max(0.0, dot(P, P) - Ls * Ls))) : 1.0;
      vec3 ringAlb = pow(mix(vec3(0.62, 0.52, 0.4), vec3(0.85, 0.78, 0.65), bandN), vec3(2.2));
      ringC = ringAlb * (keyCol * (0.1 + 0.9 * shadow) + vec3(0.02, 0.03, 0.05) * g * g * g);
      tRing = tr;
    }
  }
  vec3 planetC = vec3(0.0);
  if (cover > 0.0) {
    vec3 n = normalize(q + tp * sg);
    planetC = planetSurface(n, -dirT, style, seed, g, Lw, keyCol, fpR, ringed, ey);
  }
  vec3 rgb;
  float remaining;
  if (tRing < tp || cover <= 0.0) {
    rgb = ringA * ringC + (1.0 - ringA) * cover * planetC;
  } else {
    rgb = cover * planetC + (1.0 - cover) * ringA * ringC;
  }
  remaining = (1.0 - ringA) * (1.0 - cover);
  return vec4(rgb, 1.0 - remaining);
}
void applyDisk(vec3 hit, vec3 direction, float footprint, inout vec3 color, inout float transmission) {
  vec4 emission = diskEmission(hit, direction, footprint);
  color += transmission * emission.rgb;
  // Dense foreground material occludes the photon ring and later disk images.
  transmission *= 1.0 - emission.a;
}
float glowAntiderivative(float s, float A2) {
  return s * inversesqrt(A2 + s * s) / A2;
}
vec3 acceleration(vec3 p, vec3 velocity, float h2) {
  float r2 = dot(p, p), r = sqrt(r2);
  vec3 gravity = -3.0 * h2 * p / (r2 * r2 * r);
  // A small gravitomagnetic term approximates Kerr frame dragging, not a Kerr metric.
  vec3 axis = vec3(worldToDisk[0][1], worldToDisk[1][1], worldToDisk[2][1]);
  vec3 drag = 0.16 * spin * cross(velocity, axis - 3.0 * dot(axis, p) * p / r2) / (r2 * r);
  return lensingStrength * (gravity + drag);
}
void main() {
  vec2 screen = vUv * 2.0 - 1.0;
  vec3 velocity = cameraRotation * normalize(vec3(screen.x * aspect * tanHalfFov, screen.y * tanHalfFov, -1.0));
  vec3 p = cameraPositionWorld / mass;
  vec3 angularMomentum = cross(p, velocity);
  float h2 = dot(angularMomentum, angularMomentum);
  int bodyCandidates[16];
  int bodyCandidateCount = 0;
  float planeLength = sqrt(max(h2, 0.0));
  if (bodyCount > 0) {
    for (int j = 0; j < 16; j++) {
      if (j >= bodyCount) break;
      vec4 A = bodyA[j], C = bodyC[j], D = bodyD[j];
      float kind = D.x, R = A.w;
      float bound = R * (kind < 0.5 ? 1.85 : (kind < 1.5 ? 5.6 :
        (D.w < 0.5 && fract(D.z * 0.618034) > 0.45 ? 2.4 : 1.1)));
      vec3 center = A.xyz / mass;
      float planeDistance = planeLength > 1e-5
        ? abs(dot(center, angularMomentum)) / planeLength
        : 0.0;
      float reach = bound * C.w + 0.6 * spin + 0.05;
      if (planeLength <= 1e-5 || planeDistance <= reach) {
        bodyCandidates[bodyCandidateCount] = j;
        bodyCandidateCount++;
      }
    }
  }
  vec3 color = vec3(0.0);
  float transmission = 1.0, photonGlow = 0.0;
  int hitIndex = -1;
  vec3 hitQ = vec3(0.0), hitSeg = vec3(0.0);
  float hitSs = 0.0, hitQs = 0.0, hitQq = 0.0, hitT = 0.0, hitTExit = 0.0, hitTransmission = 0.0;
  // Light gathered in front of the body hit; the march continues so the body's partial coverage
  // (anti-aliased edges, the probe's bounding volume around its hull) can blend over what lies behind.
  vec3 colorAtHit = vec3(0.0);
  float glowAtHit = 0.0;
  float coronaEnergy = 0.0, coronaTemp = 5800.0, coronaG = 1.0, coronaTransmission = 1.0;
  bool escaped = false;
  bool bending = lensing && lensingStrength > 0.0;
  float invMass = 1.0 / mass;
  vec3 camM = cameraPositionWorld * invMass;
  float pad = pixelAngle * (length(camM) + 30.0);
  vec3 a = bending ? acceleration(p, velocity, h2) : vec3(0.0);
  for (int stepIndex = 0; stepIndex < 180; stepIndex++) {
    if (stepIndex >= maxSteps) break;
    float radius = length(p);
    if (radius <= 2.0) break;
    if (radius > 55.0 && dot(p, velocity) > 0.0) { escaped = true; break; }
    float stepSize = bending ? clamp((radius - 1.8) * 0.30, 0.15, 8.0) : 4.0;
    vec3 next = p + velocity * stepSize + 0.5 * a * stepSize * stepSize;
    vec3 nextA = bending ? acceleration(next, velocity, h2) : vec3(0.0);
    vec3 nextVelocity = velocity + 0.5 * (a + nextA) * stepSize;
    vec3 segment = next - p;
    float segment2 = dot(segment, segment);
    bool horizonHit = false;
    float horizonFraction = 2.0;
    if (radius < 6.1) {
      float nearest = clamp(-dot(p, segment) / segment2, 0.0, 1.0);
      vec3 closest = p + nearest * segment;
      horizonHit = dot(closest, closest) <= 4.0;
    }
    if (horizonHit) {
      float b = dot(p, segment);
      horizonFraction = (-b - sqrt(max(0.0, b * b - segment2 * (dot(p, p) - 4.0)))) / segment2;
    }
    vec3 diskP = worldToDisk * p, diskNext = worldToDisk * next;
    bool diskPending = false;
    float diskFraction = 2.0, diskFootprint = 0.0;
    vec3 diskHit = vec3(0.0), diskDirection = vec3(0.0);
    if (disk && diskP.y * diskNext.y < 0.0) {
      float fraction = -diskP.y / (diskNext.y - diskP.y);
      vec3 hit = mix(diskP, diskNext, fraction);
      float r = length(hit.xz);
      if (r >= innerRadius && r <= 20.0 && fraction < horizonFraction) {
        diskDirection = worldToDisk * mix(velocity, nextVelocity, fraction);
        // Analytic ray-cone footprint is defined even when adjacent pixels cross on different steps.
        diskFootprint = length(hit - worldToDisk * camM) * pixelAngle / max(0.25, abs(normalize(diskDirection).y));
        diskHit = hit; diskFraction = fraction; diskPending = true;
      }
    }
    float segLen = sqrt(segment2);
    vec3 segDir = segment / segLen;
    float nearestFraction = clamp(-dot(p, segment) / segment2, 0.0, 1.0);
    float segmentMinRadius = length(p + nearestFraction * segment);
    float segmentMaxRadius = max(radius, length(next));
    float curvaturePad = 0.125 * length(a) * stepSize * stepSize + 0.02;
    if (bodyCandidateCount > 0 && hitIndex < 0) {
      for (int candidateIndex = 0; candidateIndex < 16; candidateIndex++) {
        if (candidateIndex >= bodyCandidateCount) break;
        int j = bodyCandidates[candidateIndex];
        vec4 A = bodyA[j], C = bodyC[j], D = bodyD[j];
        float R = A.w, kind = D.x;
        bool ringed = kind > 1.5 && D.w < 0.5 && fract(D.z * 0.618034) > 0.45;
        float bound = R * (kind < 0.5 ? 1.85 : (kind < 1.5 ? 5.6 : (ringed ? 2.4 : 1.1))) + pad;
        vec3 center = A.xyz * invMass;
        float centerRadius = length(center);
        float radialReach = bound * C.w + curvaturePad;
        if (centerRadius + radialReach < segmentMinRadius ||
            centerRadius - radialReach > segmentMaxRadius) continue;
        float reach = bound * C.w + segLen;
        vec3 q = p - center;
        if (dot(q, q) > reach * reach) continue;
        float sk = 1.0 - 1.0 / C.w;
        q -= C.xyz * dot(q, C.xyz) * sk;
        vec3 sg = segment - C.xyz * dot(segment, C.xyz) * sk;
        float ss = dot(sg, sg), qs = dot(q, sg), qq = dot(q, q);
        float disc = qs * qs - ss * (qq - bound * bound);
        if (disc < 0.0) continue;
        float root = sqrt(disc);
        float tEnter = (-qs - root) / ss, tExit = (-qs + root) / ss;
        if (tExit < 0.0 || tEnter >= 1.0) continue;
      vec4 B = bodyB[j];
      if (kind > 0.5 && kind < 1.5) {
        float rho = sqrt(max(0.0, qq - qs * qs / ss)) / R;
        float glow = (1.0 - smoothstep(1.0, 5.6, rho)) * exp(-rho * 0.45) * stepSize * 0.06;
        if (glow > coronaEnergy) {
          coronaEnergy = glow;
          coronaTemp = D.y;
          coronaG = B.w;
          if (doppler) coronaG *= sqrt(max(0.0, 1.0 - dot(B.xyz, B.xyz))) / max(0.05, 1.0 + dot(B.xyz, segDir));
          coronaTransmission = transmission;
        }
      }
      float tBody = tEnter;
      if (kind > 0.5) {
        float tc = -qs / ss;
        float bodyDisc = qs * qs - ss * (qq - R * R);
        if (bodyDisc < 0.0) continue;
        tBody = tc - sqrt(bodyDisc) / ss;
      }
      if (tBody < 0.0 || tBody > 1.0 || tBody >= horizonFraction) continue;
      if (diskPending && diskFraction < tBody) {
        applyDisk(diskHit, diskDirection, diskFootprint, color, transmission);
        diskPending = false;
      }
      hitIndex = j;
      hitQ = q;
      hitSeg = sg;
      hitSs = ss;
      hitQs = qs;
      hitQq = qq;
      hitT = tBody;
      hitTExit = tExit;
      hitTransmission = transmission;
      colorAtHit = color;
      glowAtHit = photonGlow;
      break;
    }
    }
    if (diskPending) applyDisk(diskHit, diskDirection, diskFootprint, color, transmission);
    if (disk && bending) photonGlow += transmission * exp(-pow((radius - 3.0) * 6.0, 2.0)) * smoothstep(20.0, 27.0, h2) * stepSize * 0.035;
    if (horizonHit || transmission < 0.015) break;
    p = next; velocity = nextVelocity; a = nextA;
  }
  vec4 bodyResult = vec4(0.0);
  if (hitIndex >= 0) {
    vec4 A = bodyA[hitIndex], B = bodyB[hitIndex], C = bodyC[hitIndex], D = bodyD[hitIndex];
    float kind = D.x, R = A.w, g = B.w;
    if (doppler) g *= sqrt(max(0.0, 1.0 - dot(B.xyz, B.xyz))) / max(0.05, 1.0 + dot(B.xyz, normalize(hitSeg)));
    vec3 center = A.xyz * invMass;
    float centerR = max(length(center), 0.5);
    vec3 Lw = -center / centerR;
    float keyI = 4.8 * pow(clamp(12.0 / max(centerR, 3.0), 0.12, 2.5), 1.5);
    vec3 keyCol = blackbody(diskTemp * g) * (keyI * g * g * g);
    float fpM = max(length(center - camM), 1.0) * pixelAngle;
    vec4 result = vec4(0.0);
    if (kind < 0.5) {
      vec3 forward = dot(B.xyz, B.xyz) > 1e-6 ? normalize(B.xyz) : -C.xyz;
      result = shipColor(hitQ + hitT * hitSeg, hitSeg * inversesqrt(hitSs), (hitTExit - hitT) * sqrt(hitSs), R, fpM / R, g, D.w, forward, Lw, keyCol);
    } else if (kind < 1.5) {
      float rho2 = max(0.0, hitQq - hitQs * hitQs / hitSs);
      float cover = clamp((R - sqrt(rho2)) / fpM + 0.5, 0.0, 1.0);
      vec3 n = normalize(hitQ + hitT * hitSeg);
      float mu = clamp(dot(n, -hitSeg * inversesqrt(hitSs)), 0.0, 1.0);
      float T0 = D.y;
      float corona = 1.0 - smoothstep(1.0, 4.5, sqrt(rho2) / R);
      result.rgb = cover * starSurface(n, mu, T0, g, D.z, fpM / R)
                 + blackbody(T0 * g) * starLuminosity(T0) * pow(g, 4.0) * corona * 0.03;
      result.a = cover;
    } else {
      bool ringed = D.w < 0.5 && fract(D.z * 0.618034) > 0.45;
      result = planetShade(hitQ, hitSeg, hitSs, hitQs, hitQq, R, ringed, D.w, D.z, g, Lw, keyCol, fpM, 2.0);
    }
    bodyResult = result;
  }
  color += blackbody(diskTemp) * photonGlow;
  if (escaped) color += transmission * background(velocity);
  if (hitIndex >= 0) {
    vec3 front = colorAtHit + blackbody(diskTemp) * glowAtHit;
    color = front + hitTransmission * bodyResult.rgb + (1.0 - bodyResult.a) * (color - front);
  }
  if (coronaEnergy > 0.0) {
    color += coronaTransmission * blackbody(coronaTemp * coronaG) * starLuminosity(coronaTemp) * pow(coronaG, 4.0) * coronaEnergy;
  }
  gl_FragColor = vec4(color, 1.0);
}
`;
