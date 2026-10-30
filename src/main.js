import * as THREE from 'three';
import { ProbeSystem } from './physics/probe.js';
import { OrbiterSystem } from './physics/orbiters.js';
import { DEFAULT_SETTINGS, PARAM_RANGES, PRESETS, applyPreset as presetSettings, clampSettings } from './physics/presets.js';
import { decayCoefficient, iscoRadius, schwarzschildRadius, schwarzschildRadiusKm, starStretchFactor, timeDilation } from './physics/schwarzschild.js';
import { photonReleasePoint } from './physics/photon.js';
import { CameraRig } from './camera/rig.js';
import { ObserverClock } from './camera/clock.js';
import { createPanel } from './ui/panel.js';
import { createHud } from './ui/hud.js';
import { createRenderer } from './scene/renderer.js';
import { createPost } from './scene/post.js';
import { QualityScaler } from './scene/quality.js';
import './ui/style.css';

const host = document.querySelector('#observatory');
let settings = { ...DEFAULT_SETTINGS, camera: { ...DEFAULT_SETTINGS.camera } };
const view = createRenderer(host);
const { renderer, camera } = view;
const rig = new CameraRig(camera, renderer.domElement);
rig.setPose(settings.camera);
const particles = new ProbeSystem();
const orbiters = new OrbiterSystem();
const clock = new ObserverClock();
const quality = new QualityScaler();
const post = createPost(renderer, view.scene, view.quadCamera);
let frame = 0;
let simTime = 0;
let fps = 0;
let fpsStart = performance.now();
let fpsFrames = 0;
let hudUpdated = -Infinity;
let lastFrameTime = performance.now();
let raf = 0;
let benchmarking = false;
const gl = renderer.getContext();
const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info');
const rendererName = debugRenderer ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL) : 'unknown';
const syncPixel = new Uint8Array(4);
const screenRight = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
const diskNormal = new THREE.Vector3();
const tangent = new THREE.Vector3();

function copySettings() {
  return { ...settings, camera: { ...settings.camera } };
}
function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  post.resize(window.innerWidth, window.innerHeight, quality.renderScale);
}
function set(partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new TypeError('Settings must be an object.');
  for (const key of Object.keys(partial)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new TypeError(`Unknown setting: ${key}`);
  }
  for (const key of ['lensing', 'doppler', 'stars', 'disk', 'paused', 'hud', 'bloom', 'grain', 'cinematic']) {
    if (key in partial && typeof partial[key] !== 'boolean') throw new TypeError(`${key} must be boolean.`);
  }
  for (const key of Object.keys(PARAM_RANGES)) {
    if (key in partial && !Number.isFinite(partial[key])) throw new TypeError(`${key} must be finite.`);
  }
  if ('quality' in partial && partial.quality !== 'auto' && !Number.isFinite(partial.quality)) throw new TypeError('Quality must be auto or a finite render scale.');
  if ('massSolarPerUnit' in partial && (!Number.isFinite(partial.massSolarPerUnit) || partial.massSolarPerUnit <= 0)) throw new RangeError('Physical mass scale must be positive.');
  if ('preset' in partial && partial.preset !== 'custom' && !Object.hasOwn(PRESETS, partial.preset)) throw new RangeError('Unknown preset.');
  let nextCamera = settings.camera;
  if ('camera' in partial) {
    if (!partial.camera || typeof partial.camera !== 'object') throw new TypeError('Camera pose must be an object.');
    nextCamera = { ...settings.camera, ...partial.camera };
    if (![nextCamera.distance, nextCamera.inclinationDeg, nextCamera.azimuthDeg].every(Number.isFinite)) throw new TypeError('Camera coordinates must be finite.');
    if (nextCamera.distance <= 0 || nextCamera.inclinationDeg <= 0 || nextCamera.inclinationDeg >= 180) throw new RangeError('Camera distance must be positive and inclination strictly between 0 and 180 degrees.');
  }
  const parametersChanged = Object.keys(PARAM_RANGES).some((key) => key in partial);
  settings = clampSettings({ ...settings, ...partial, camera: nextCamera });
  if (parametersChanged && !('preset' in partial)) settings.preset = 'custom';
  rig.update(0, settings.mass);
  if ('camera' in partial) rig.setPose(nextCamera);
  if ('cinematic' in partial) rig.setCinematic(settings.cinematic);
  settings.camera = rig.getPose();
  if (typeof settings.quality === 'number' && quality.pin(settings.quality)) resize();
  syncUi();
  return copySettings();
}
function applyPreset(id) {
  return set(presetSettings(settings, id));
}
function dropProbe(opts = {}) {
  return particles.drop(opts, settings.mass, camera.position.toArray());
}
const clickNdc = new THREE.Vector2();
const clickRay = new THREE.Raycaster();
const clickForward = new THREE.Vector3();
// Release a probe at rest exactly under the cursor: on the pixel's lensed light ray, in front of the
// disk if the ray hits it, otherwise on the plane through the hole facing the camera.
function dropProbeAtClient(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  clickNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
  clickRay.setFromCamera(clickNdc, camera);
  const { mass, spin, diskTilt } = settings;
  const tilt = THREE.MathUtils.degToRad(diskTilt);
  const cameraDistance = camera.position.length() / mass;
  const point = photonReleasePoint({
    origin: camera.position.toArray().map((x) => x / mass),
    direction: clickRay.ray.direction.toArray(),
    forward: camera.getWorldDirection(clickForward).toArray(),
    bend: settings.lensing ? settings.lensingStrength : 0,
    spin,
    diskAxis: [0, Math.cos(tilt), Math.sin(tilt)],
    disk: settings.disk,
    innerRadius: iscoRadius(mass, spin) / mass,
    minRadius: Math.max(3, Math.min(6, 0.6 * cameraDistance)),
  });
  return dropProbe({ position: point.map((x) => x * mass), velocity: [0, 0, 0] });
}
function addOrbiter(opts = {}) {
  return orbiters.add(opts, settings.mass, settings);
}
function clearOrbiters() {
  orbiters.clear();
}
function toggle(key) {
  set({ [key]: !settings[key] });
}
const hud = createHud(host);
const panel = createPanel(host, {
  settings, ranges: PARAM_RANGES, presets: PRESETS,
  onChange: set, onPreset: applyPreset, onDropProbe: dropProbe, onAddOrbiter: (kind) => addOrbiter({ kind }), onClearOrbiters: clearOrbiters,
  onCinematic: (on) => set({ cinematic: on }), onFlight: (dir) => rig.setFlight(dir), onToggle: toggle,
});
function syncUi() {
  panel.sync(settings);
  panel.setVisible(settings.hud && !settings.cinematic);
  hud.setVisible(settings.hud && !settings.cinematic);
}
function approachingSide() {
  camera.updateMatrixWorld();
  screenRight.setFromMatrixColumn(camera.matrixWorld, 0);
  const tilt = THREE.MathUtils.degToRad(settings.diskTilt);
  diskNormal.set(0, Math.cos(tilt), Math.sin(tilt));
  screenRight.addScaledVector(diskNormal, -screenRight.dot(diskNormal)).normalize();
  tangent.crossVectors(diskNormal, screenRight);
  cameraDirection.copy(camera.position).normalize();
  return tangent.dot(cameraDirection) > 0 ? 'right' : 'left';
}
function clockState() {
  return { properTime: clock.properTime, coordTime: clock.coordTime, rate: clock.rate };
}
const renderBodies = [];
function updateAndRender(now, delta) {
  const dtReal = Math.min(Math.max(delta, 0), 0.1);
  const motion = rig.update(dtReal, settings.mass);
  Object.assign(settings.camera, rig.getPose());
  const dtSim = settings.paused ? 0 : dtReal * 24 * settings.timeScale;
  simTime += dtSim;
  particles.step(dtSim, settings.mass);
  orbiters.step(dtSim, settings.mass, decayCoefficient(settings.orbitDecay));
  clock.update(dtSim, motion.distance, settings.mass);
  if (!benchmarking && quality.update(delta, settings.quality)) resize();
  renderBodies.length = 0;
  for (const probe of particles.list) renderBodies.push(probe);
  for (const orbiter of orbiters.list) renderBodies.push(orbiter);
  view.update(settings, simTime, renderBodies, starStretchFactor(motion.distance, settings.mass, motion.radialBeta), quality.maxSteps);
  post.render(now / 1000, settings);
  frame++;
  fpsFrames++;
  const elapsed = (now - fpsStart) / 1000;
  if (elapsed >= 0.8) {
    fps = fpsFrames / elapsed;
    fpsFrames = 0;
    fpsStart = now;
  }
  if (now - hudUpdated >= 100) {
    const probe = particles.list.at(-1);
    const orbiter = orbiters.list.at(-1);
    const massSolar = settings.mass * settings.massSolarPerUnit;
    hud.update({
      mass: settings.mass, massSolar, rs: schwarzschildRadius(settings.mass), rsKm: schwarzschildRadiusKm(massSolar),
      fps, renderScale: quality.renderScale, presetLabel: PRESETS[settings.preset]?.label ?? 'Custom', clock: clockState(),
      probe: probe ? { r: probe.apparent.r, timeDilation: timeDilation(probe.apparent.r, settings.mass), redshift: probe.apparent.redshift, captured: probe.captured, frozen: probe.apparent.frozen, apparentR: probe.apparent.r } : null,
      orbiters: {
        count: orbiters.list.length,
        latest: orbiter ? {
          kind: orbiter.kind, style: orbiter.style, temperature: orbiter.temperature, r: orbiter.apparent.r, status: orbiter.status,
          orbits: orbiter.orbits, redshift: orbiter.apparent.redshift,
          inspiralSeconds: settings.paused || !(settings.timeScale > 0) ? Infinity : orbiter.inspiralTime / (24 * settings.timeScale),
        } : null,
      },
    });
    hudUpdated = now;
  }
}
function animate() {
  if (benchmarking) return;
  // A queued rAF timestamp can predate a synchronous benchmark; sample the clock now.
  const now = performance.now();
  updateAndRender(now, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  raf = requestAnimationFrame(animate);
}
async function benchmark(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new RangeError('Benchmark duration must be between 0 and 60 seconds.');
  if (benchmarking) throw new Error('A benchmark is already running.');
  benchmarking = true;
  cancelAnimationFrame(raf);
  const saved = { scale: quality.renderScale, bloom: settings.bloom, grain: settings.grain };
  quality.pin(1);
  settings.bloom = true;
  settings.grain = true;
  resize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const start = performance.now();
  let previous = start;
  let frames = 0;
  try {
    do {
      const now = performance.now();
      updateAndRender(now, (now - previous) / 1000);
      previous = now;
      // A one-pixel readback synchronizes every complete post-processed frame with the GPU.
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
      frames++;
    } while (performance.now() - start < seconds * 1000);
    const elapsed = (performance.now() - start) / 1000;
    return { frames, seconds: elapsed, fps: frames / elapsed, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
  } finally {
    quality.pin(saved.scale);
    settings.bloom = saved.bloom;
    settings.grain = saved.grain;
    resize();
    benchmarking = false;
    lastFrameTime = performance.now();
    fpsStart = lastFrameTime;
    fpsFrames = 0;
    raf = requestAnimationFrame(animate);
  }
}
window.addEventListener('resize', resize);
const toggleKeys = { l: 'lensing', d: 'doppler', s: 'stars', h: 'hud', c: 'cinematic', b: 'bloom', g: 'grain' };
window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    rig.setFlight(event.key === 'ArrowUp' ? -1 : 1);
  } else if (!event.repeat) {
    const key = event.key.toLowerCase();
    if (key === 'p') dropProbe();
    else if (key === '1') addOrbiter({ kind: 'star' });
    else if (key === '2') addOrbiter({ kind: 'planet' });
    else if (key === 'x') clearOrbiters();
    else if (toggleKeys[key]) toggle(toggleKeys[key]);
  }
});
window.addEventListener('keyup', (event) => {
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') rig.setFlight(0);
});
window.addEventListener('blur', () => rig.setFlight(0));
let pointer = null;
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.isPrimary) { pointer = null; return; }
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 4) pointer.moved = true;
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (pointer?.id === event.pointerId && !pointer.moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 4) dropProbeAtClient(event.clientX, event.clientY);
  pointer = null;
});
renderer.domElement.addEventListener('pointercancel', () => { pointer = null; });
resize();
syncUi();
updateAndRender(performance.now(), 0);
window.__sim = {
  ready: true, set, applyPreset, dropProbe, clearProbes: () => particles.clear(), addOrbiter, clearOrbiters, benchmark,
  getState: () => ({ settings: copySettings(), rs: schwarzschildRadius(settings.mass), fps, frame, simTime,
    approachingSide: approachingSide(), renderer: rendererName, renderScale: quality.renderScale,
    clock: clockState(), probes: structuredClone(particles.list), orbiters: structuredClone(orbiters.list),
  }),
};
raf = requestAnimationFrame(animate);
