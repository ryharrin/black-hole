// End-to-end verification of the black hole simulator against the built dist/ via `vite preview`.
// Usage: npm run build && npm run verify   (exit 0 only if every check passes)
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4173;
const URL_BASE = `http://localhost:${PORT}/`;
const ORIGIN = new URL(URL_BASE).origin;
const CHROMIUM_ARGS = [
  '--disable-frame-rate-limit', '--disable-gpu-vsync', '--use-angle=metal',
  '--enable-gpu', '--ignore-gpu-blocklist',
];
const CAMERA = { distance: 30, inclinationDeg: 80, azimuthDeg: 0 };
// v2 defaults (mirrors DEFAULT_SETTINGS in src/physics/presets.js); used to reset state between checks.
const DEFAULTS = {
  mass: 1, spin: 0, diskTemp: 6500, diskTilt: 0, lensingStrength: 1, timeScale: 1, massSolarPerUnit: 4.3e6,
  preset: 'custom', lensing: true, doppler: true, stars: true, disk: true, paused: false, hud: true,
  bloom: true, grain: true, quality: 'auto', cinematic: false, camera: { ...CAMERA },
  orbitDecay: 0.35, orbitRadius: 14,
};
// Deterministic pixel measurements: no overlays, no grain, default physics.
const PIXEL_BASE = { hud: false, grain: false, bloom: true, mass: 1, spin: 0, diskTilt: 0, lensingStrength: 1 };
const ASSET_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.ktx2',
  '.hdr', '.exr', '.glb', '.gltf', '.obj', '.fbx', '.woff', '.woff2', '.ttf', '.otf']);

// ---- check recording -------------------------------------------------------
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  return ok;
}
const f = (x, d = 3) => (typeof x === 'number' ? x.toFixed(d) : String(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- helpers ---------------------------------------------------------------
async function waitForUrl(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

// Apply settings, then wait for 3 requestAnimationFrame callbacks so they take effect.
async function setAndWait(page, partial) {
  await page.evaluate(async (p) => {
    window.__sim.set(p);
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
  }, partial);
}

const getState = (page) => page.evaluate(() => window.__sim.getState());
const restoreDefaults = (page, extra = {}) => setAndWait(page, { ...DEFAULTS, camera: { ...CAMERA }, ...extra });
// Remove every probe and orbiter so each check starts from an empty scene.
const resetBodies = (page) => page.evaluate(() => { window.__sim.clearProbes(); window.__sim.clearOrbiters(); });

// Poll an async predicate until it returns truthy or the timeout expires; returns its last value.
async function waitUntil(fn, timeoutMs, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v || Date.now() >= end) return v;
    await sleep(stepMs);
  }
}

// Click a DOM element via el.click() (works even if the panel is collapsed); false if the element is missing.
const domClick = (page, selector) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  el.click();
  return true;
}, selector);

// Set a range/number input's value and fire input + change events like a user drag would.
const setControl = (page, selector, value) => page.evaluate(async ({ selector, value }) => {
  const root = document.querySelector(selector);
  const el = root && (root.matches('input') ? root : root.querySelector('input'));
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
  return true;
}, { selector, value });

// Run `npm test` (node --test tests/) and report exit code plus the tail of its output.
function runNpmTest() {
  return new Promise((resolveRun) => {
    const p = spawn('npm', ['test'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolveRun({ code: -1, out: String(e) }));
    p.on('close', (code) => resolveRun({ code, out }));
  });
}

// Shortest angular difference in degrees (azimuth wraps at 360).
const angleDelta = (a, b) => Math.abs(((b - a + 540) % 360 + 360) % 360 - 180);
const angularPoseDelta = (a, b) => Math.max(Math.abs(a.inclinationDeg - b.inclinationDeg), angleDelta(a.azimuthDeg, b.azimuthDeg));
const poseDelta = (a, b) => Math.max(Math.abs(a.distance - b.distance), angularPoseDelta(a, b));

const shot = async (page) => (await page.screenshot({ type: 'png' })).toString('base64');

// Decode PNG(s) in the page and compute luminance statistics (Rec.709, 0-1).
//   center: mean luminance of centered square, side = 2% of height (a)
//   diff:   mean |La - Lb| inside centered circle of radius 30% of height (a, b)
//   halves: mean luminance of left/right halves, excluding a centered 10%-width band (a)
function analyze(page, kind, a, b) {
  return page.evaluate(async ({ kind, a, b }) => {
    async function lum(b64) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const L = new Float32Array(bmp.width * bmp.height);
      for (let i = 0; i < L.length; i++) {
        L[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
      }
      return { L, w: bmp.width, h: bmp.height };
    }
    const A = await lum(a);
    const { w, h } = A;
    const cx = w / 2, cy = h / 2;
    if (kind === 'center') {
      const half = (0.02 * h) / 2;
      let s = 0, n = 0;
      for (let y = Math.ceil(cy - half); y < cy + half; y++)
        for (let x = Math.ceil(cx - half); x < cx + half; x++) { s += A.L[y * w + x]; n++; }
      return { value: s / n, w, h };
    }
    if (kind === 'diff') {
      const B = await lum(b);
      const R = 0.3 * h;
      let s = 0, n = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= R * R) { s += Math.abs(A.L[y * w + x] - B.L[y * w + x]); n++; }
        }
      return { value: s / n, w, h };
    }
    // halves
    const band = 0.05 * w;
    let sl = 0, nl = 0, sr = 0, nr = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (x < cx - band) { sl += A.L[y * w + x]; nl++; }
        else if (x >= cx + band) { sr += A.L[y * w + x]; nr++; }
      }
    return { left: sl / nl, right: sr / nr, w, h };
  }, { kind, a, b });
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]);
}

// ---- main ------------------------------------------------------------------
let server, browser;
const cleanup = async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { server?.kill('SIGTERM'); } catch { /* ignore */ }
};
const watchdog = setTimeout(async () => {
  console.error('FAIL timeout: verify exceeded 360 s');
  await cleanup();
  process.exit(1);
}, 360_000);

try {
  // 0a. unit tests (before the browser)
  const unit = await runNpmTest();
  const unitTail = unit.out.trim().split('\n').slice(-12).join('\n    ');
  check('npm-test', unit.code === 0, `npm test exit code ${unit.code} (threshold: 0)` + (unit.code === 0 ? '' : `\n    ${unitTail}`));

  // 0. dist + preview server
  const dist = join(ROOT, 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    check('dist', false, 'dist/index.html missing - run `npm run build` first');
    throw new Error('dist/index.html missing');
  }
  server = spawn(join(ROOT, 'node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore' });
  server.on('error', (e) => console.error('preview server error:', e.message));
  if (!(await waitForUrl(URL_BASE, 20_000))) throw new Error(`preview server did not respond at ${URL_BASE} within 20 s`);

  // 1. browser + collectors
  browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));

  // 2. load + GPU
  await page.goto(URL_BASE);
  await page.waitForFunction('window.__sim && window.__sim.ready', null, { timeout: 20_000 });
  const renderer = await page.evaluate(() => window.__sim.getState().renderer);
  console.log(`renderer: ${renderer}`);
  check('gpu', !renderer.includes('SwiftShader'), `renderer="${renderer}" (threshold: must not contain SwiftShader)`);

  // 3. lensing
  await setAndWait(page, { ...PIXEL_BASE, stars: true, disk: true, doppler: true, lensing: true, paused: true, cinematic: false, camera: CAMERA });
  const lensOn = await shot(page);
  await setAndWait(page, { lensing: false });
  const lensOff = await shot(page);
  const center = await analyze(page, 'center', lensOn);
  check('lensing-shadow', center.value < 0.03,
    `centerLum=${f(center.value, 4)} on ${center.w}x${center.h}, centered square side 2% of height (threshold < 0.03)`);
  const diff = await analyze(page, 'diff', lensOn, lensOff);
  check('lensing-diff', diff.value > 0.04,
    `lensDiff=${f(diff.value, 4)}, mean |dLum| within centered circle r=30% of height (threshold > 0.04)`);

  // 4. doppler (stars off so only the disk contributes)
  await setAndWait(page, { lensing: true, stars: false, doppler: true, paused: true, camera: CAMERA });
  const dopOn = await shot(page);
  const side = await page.evaluate(() => window.__sim.getState().approachingSide);
  await setAndWait(page, { doppler: false });
  const dopOff = await shot(page);
  const ratioOf = (h) => {
    const appr = side === 'left' ? h.left : h.right;
    const rec = side === 'left' ? h.right : h.left;
    return { appr, rec, ratio: appr / Math.max(rec, 1e-6) };
  };
  const dOn = ratioOf(await analyze(page, 'halves', dopOn));
  check('doppler', dOn.ratio >= 1.5,
    `approachingSide=${side} approaching=${f(dOn.appr, 4)} receding=${f(dOn.rec, 4)} ratio=${f(dOn.ratio)} ` +
    `(left/right halves excluding central 10% band; threshold >= 1.5)`);
  const dOff = ratioOf(await analyze(page, 'halves', dopOff));
  check('doppler-control', dOff.ratio < 1.2,
    `doppler off: approaching=${f(dOff.appr, 4)} receding=${f(dOff.rec, 4)} controlRatio=${f(dOff.ratio)} (threshold < 1.2)`);
  await setAndWait(page, { stars: true, doppler: true, hud: true });

  // 5. probe (real key press)
  await page.evaluate(() => { window.__sim.set({ paused: false, timeScale: 1 }); window.__sim.clearProbes(); });
  await page.keyboard.press('p');
  const getProbe = () => page.evaluate(() => window.__sim.getState().probes[0] ?? null);
  let probe = null;
  for (const t0 = Date.now(); Date.now() - t0 < 1000 && !probe; ) { probe = await getProbe(); if (!probe) await sleep(50); }
  const dropped = check('probe-drop-key', !!probe, probe ? `probe id=${probe.id} appeared after pressing "p"` : 'no probe in getState().probes within 1 s of pressing "p"');
  if (!dropped) {
    check('probe-infall', false, 'skipped: no probe');
    check('probe-capture', false, 'skipped: no probe');
    check('probe-freeze', false, 'skipped: no probe');
  } else {
    const tDrop = Date.now();
    const r0 = probe.r;
    const samples = [r0];
    let cur = probe;
    for (let i = 0; i < 8 && !cur.captured; i++) {
      await sleep(250);
      cur = (await getProbe()) ?? cur;
      samples.push(cur.r);
    }
    let nonDec = 0;
    for (let i = 1; i < samples.length; i++) if (!(samples[i] < samples[i - 1])) nonDec++;
    const rEnd2s = samples[samples.length - 1];
    check('probe-infall', nonDec <= 1 && r0 - rEnd2s > 0.5,
      `initial r=${f(r0)} r@2s=${f(rEnd2s)} drop=${f(r0 - rEnd2s)} nonDecreasingSteps=${nonDec} samples=[${samples.map((s) => f(s, 2)).join(', ')}] ` +
      `(threshold: <=1 non-decreasing step, drop > 0.5)`);
    while (!cur.captured && Date.now() - tDrop < 30_000) {
      await sleep(250);
      cur = (await getProbe()) ?? cur;
    }
    const tCap = (Date.now() - tDrop) / 1000;
    check('probe-capture', cur.captured === true && cur.r <= 2.05,
      `captured=${cur.captured} initial r=${f(r0)} final r=${f(cur.r)} timeToCapture=${f(tCap, 1)}s properTime=${f(cur.properTime)} ` +
      `(threshold: captured within 30 s, final r <= 2.05)`);

    // Observer view: the probe must hang just outside the horizon, redshifted, and stop moving.
    await sleep(5000);
    const rsNow = (await getState(page)).rs;
    const a2 = (await getProbe())?.apparent;
    await sleep(1000);
    const a3 = (await getProbe())?.apparent;
    const gap = a3.r - rsNow;
    const moved = Math.abs(a3.r - a2.r);
    check('probe-freeze', a3.r > rsNow && (gap < 0.05 * rsNow || a3.frozen === true) && a3.redshift < 0.2 && moved < 0.02 * rsNow,
      `3 s after capture: apparent r=${f(a3.r, 4)} rs=${f(rsNow)} gap=${f(gap, 4)} (< ${f(0.05 * rsNow, 3)} or frozen=${a3.frozen}) ` +
      `redshift=${f(a3.redshift, 4)} (< 0.2) r change over last 1 s=${f(moved, 4)} (< ${f(0.02 * rsNow, 3)})`);
  }

  // 5b. probe button in the control panel
  await restoreDefaults(page);
  await page.evaluate(() => window.__sim.clearProbes());
  const probeBtnFound = await domClick(page, '#drop-probe');
  const probeBtnAdded = await waitUntil(async () => (await getState(page)).probes.length > 0, 1000);
  check('probe-button', probeBtnFound && probeBtnAdded,
    `#drop-probe found=${probeBtnFound}; probes after click=${(await getState(page)).probes.length} (threshold: >= 1 within 1 s)`);
  await page.evaluate(() => window.__sim.clearProbes());

  // 5c. presets (API + panel buttons)
  const PRESET_CASES = [['gargantua', 'Gargantua'], ['sgrA', 'Sagittarius A*'], ['quiet', 'Quiet']];
  const presetInfo = [];
  let presetsOk = true;
  for (const [id, label] of PRESET_CASES) {
    await restoreDefaults(page);
    await page.evaluate((i) => window.__sim.applyPreset(i), id);
    const applied = (await getState(page)).settings.preset;
    const text = await page.evaluate((i) => document.querySelector(`#preset-${i}`)?.textContent?.trim() ?? null, id);
    const ok = applied === id && text === label;
    presetsOk &&= ok;
    presetInfo.push(`${id}: preset=${applied} button="${text}"${ok ? '' : ' (BAD)'}`);
  }
  await restoreDefaults(page);
  const quietClicked = await domClick(page, '#preset-quiet');
  await setAndWait(page, {});
  const quietPreset = (await getState(page)).settings.preset;
  presetsOk &&= quietClicked && quietPreset === 'quiet';
  check('presets', presetsOk,
    `${presetInfo.join('; ')}; click #preset-quiet found=${quietClicked} -> preset=${quietPreset} (threshold: preset id and button label match)`);
  await restoreDefaults(page);

  // 5d. control panel sliders
  const CONTROL_KEYS = ['mass', 'spin', 'diskTemp', 'diskTilt', 'lensingStrength', 'timeScale'];
  const present = await page.evaluate((keys) => keys.filter((k) => document.querySelector(`#ctl-${k}`)), CONTROL_KEYS);
  const missing = CONTROL_KEYS.filter((k) => !present.includes(k));
  const massSet = await setControl(page, '#ctl-mass', 2);
  const pc = await getState(page);
  check('panel-controls', missing.length === 0 && massSet && Math.abs(pc.settings.mass - 2) < 1e-6 && Math.abs(pc.rs - 2 * pc.settings.mass) < 1e-9,
    `controls present=${present.length}/${CONTROL_KEYS.length}${missing.length ? ` missing=[${missing.join(', ')}]` : ''}; ` +
    `#ctl-mass input=2 -> settings.mass=${f(pc.settings.mass, 4)} rs=${f(pc.rs, 4)} (threshold: mass=2, rs=2*mass)`);
  await restoreDefaults(page);

  // 5e. time-dilation clock: rate = sqrt(1 - rs/distance) for a static observer
  await page.evaluate(() => window.__sim.clearProbes());
  const clockInfo = [];
  let clockOk = true;
  for (const mult of [3, null]) {
    const rs = (await getState(page)).rs;
    const dist = mult ? mult * rs : 30;
    await setAndWait(page, { camera: { ...CAMERA, distance: dist }, paused: false, cinematic: false });
    await sleep(1000);
    const rate = (await getState(page)).clock.rate;
    const expected = Math.sqrt(1 - rs / dist);
    clockOk &&= Math.abs(rate - expected) <= 0.01 * expected;
    clockInfo.push(`distance=${f(dist, 1)} rate=${f(rate, 4)} expected=${f(expected, 4)}`);
  }
  check('time-dilation-clock', clockOk, `${clockInfo.join('; ')} (threshold: clock.rate within 1% of sqrt(1 - rs/distance))`);
  await restoreDefaults(page);

  // 5f. cinematic mode drives the camera by itself; turning it off hands control back
  await setAndWait(page, { cinematic: true });
  const poseA = (await getState(page)).settings.camera;
  await sleep(2000);
  const poseB = (await getState(page)).settings.camera;
  const cinematicMoved = poseDelta(poseA, poseB);
  const entryAngular = angularPoseDelta(poseA, poseB);
  const motionOk = cinematicMoved > 0.01 && entryAngular < 15;
  const motionDetail = `pose ${JSON.stringify(poseA)} -> ${JSON.stringify(poseB)} over 2 s, maxDelta=${f(cinematicMoved, 4)} (threshold: > 0.01), ` +
    `angular delta=${f(entryAngular, 3)} deg (threshold: < 15 for a slow entry)`;
  await setAndWait(page, { cinematic: false });
  await sleep(1000);
  const poseC = (await getState(page)).settings.camera;
  await sleep(500);
  const poseD = (await getState(page)).settings.camera;
  const settledDelta = poseDelta(poseC, poseD);
  check('cinematic', motionOk && settledDelta < 0.01,
    `${motionDetail}; 1 s after cinematic off, pose change over next 0.5 s=${f(settledDelta, 5)} (threshold: < 0.01)`);
  await restoreDefaults(page);

  // 5g. orbiters: panel buttons, stable orbit, decay + capture, rendering of bodies
  await restoreDefaults(page);
  await resetBodies(page);
  const starBtn = await domClick(page, '#add-star');
  const planetBtn = await domClick(page, '#add-planet');
  await sleep(100);
  const afterAdd = (await getState(page)).orbiters.map((o) => o.kind);
  const clearBtn = await domClick(page, '#clear-orbiters');
  await sleep(100);
  const afterClear = (await getState(page)).orbiters.length;
  check('orbiter-buttons', starBtn && planetBtn && clearBtn && afterAdd.includes('star') && afterAdd.includes('planet') && afterClear === 0,
    `#add-star found=${starBtn} #add-planet found=${planetBtn} #clear-orbiters found=${clearBtn}; kinds after adds=[${afterAdd.join(', ')}] ` +
    `orbiters after clear=${afterClear} (threshold: star and planet present, 0 after clear)`);

  // stable: no decay -> circular geodesic orbit at r=12 keeps its radius and keeps moving
  await restoreDefaults(page, { orbitDecay: 0 });
  await resetBodies(page);
  await page.evaluate(() => window.__sim.addOrbiter({ kind: 'star', radius: 12, eccentricity: 0, inclinationDeg: 0 }));
  const getOrbiter = () => page.evaluate(() => window.__sim.getState().orbiters[0] ?? null);
  const azimuthOf = (o) => (Math.atan2(o.position[0], o.position[2]) * 180) / Math.PI;
  let orb = await getOrbiter();
  let stableOk = !!orb;
  let maxDev = 0;
  let azTotal = 0;
  let azPrev = orb ? azimuthOf(orb) : 0;
  for (const t0 = Date.now(); orb && Date.now() - t0 < 4000; ) {
    await sleep(80);
    orb = (await getOrbiter()) ?? orb;
    maxDev = Math.max(maxDev, Math.abs(orb.r - 12) / 12);
    const az = azimuthOf(orb);
    azTotal += ((az - azPrev + 540) % 360 + 360) % 360 - 180;
    azPrev = az;
  }
  stableOk &&= maxDev < 0.01 && Math.abs(azTotal) >= 30;
  check('orbiter-stable', stableOk,
    `orbitDecay=0 star r0=12 over 4 s: max |r-12|/12=${f(maxDev, 5)} (threshold < 0.01) azimuth travelled=${f(Math.abs(azTotal), 1)} deg (threshold >= 30) ` +
    `status=${orb?.status} orbits=${f(orb?.orbits ?? NaN, 2)}`);

  // decay: strong radiation reaction -> r trends down, captured within 30 s, observer sees it frozen above the horizon
  await restoreDefaults(page, { orbitDecay: 1 });
  await resetBodies(page);
  await page.evaluate(() => window.__sim.addOrbiter({ kind: 'star', radius: 14, eccentricity: 0, inclinationDeg: 0 }));
  const tAdd = Date.now();
  orb = await getOrbiter();
  const decayR = [];
  let decayOk = !!orb;
  if (orb) {
    decayR.push(orb.r);
    while (Date.now() - tAdd < 6000 && !orb.captured) {
      await sleep(250);
      orb = (await getOrbiter()) ?? orb;
      decayR.push(orb.r);
    }
    const drop6 = decayR[0] - decayR[decayR.length - 1];
    while (!orb.captured && Date.now() - tAdd < 30_000) {
      await sleep(250);
      orb = (await getOrbiter()) ?? orb;
    }
    const tCaptured = (Date.now() - tAdd) / 1000;
    await sleep(5000);
    orb = (await getOrbiter()) ?? orb;
    const rsDecay = (await getState(page)).rs;
    const gapDecay = orb.apparent.r - rsDecay;
    decayOk = drop6 > 1 && orb.captured === true && orb.apparent.r > rsDecay && (gapDecay < 0.05 * rsDecay || orb.apparent.frozen === true);
    check('orbiter-decay', decayOk,
      `orbitDecay=1 star r0=14: r ${f(decayR[0], 2)} -> ${f(decayR[decayR.length - 1], 2)} over first ${f(Math.min(6, (Date.now() - tAdd) / 1000), 1)} s ` +
      `(drop=${f(drop6, 2)}, threshold > 1) captured=${orb.captured} at ~${f(tCaptured, 1)} s (threshold: within 30 s) ` +
      `apparent r=${f(orb.apparent.r, 4)} rs=${f(rsDecay)} gap=${f(gapDecay, 4)} (< ${f(0.05 * rsDecay, 3)} or frozen=${orb.apparent.frozen})`);
  } else {
    check('orbiter-decay', false, 'no orbiter present after addOrbiter');
  }

  // bodies-render: with time paused, stars and disk off, a body in front of the hole must change the frame
  await restoreDefaults(page, { ...PIXEL_BASE, stars: false, disk: false, paused: true });
  await resetBodies(page);
  const baseline = await shot(page);
  // Find a bright test orientation for each body: a star on the camera side, a planet at quadrature.
  const nearSide = (kind) => page.evaluate((kind) => {
    const pos = (o) => (Array.isArray(o.position) ? o.position : [o.position.x, o.position.y, o.position.z]);
    let best = { score: -Infinity, phase: 0, z: -Infinity };
    for (let k = 0; k < 24; k++) {
      const phase = (k * Math.PI) / 12;
      window.__sim.clearOrbiters();
      window.__sim.addOrbiter({ kind, radius: 14, phase, inclinationDeg: 0, eccentricity: 0 });
      const o = window.__sim.getState().orbiters.at(-1);
      if (o) {
        const position = pos(o);
        const score = kind === 'planet' ? Math.abs(position[0]) : position[2];
        if (score > best.score) best = { score, phase, z: position[2] };
      }
    }
    window.__sim.clearOrbiters();
    return best;
  }, kind);
  const frames = (n = 3) => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
  const renderStats = (a, b) => page.evaluate(async ({ a, b }) => {
    async function lum(b64) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const L = new Float32Array(bmp.width * bmp.height);
      for (let i = 0; i < L.length; i++) L[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
      return { L, w: bmp.width, h: bmp.height };
    }
    const A = await lum(a);
    const B = await lum(b);
    const { w, h } = A;
    const TILE = 8;
    const tilesX = Math.ceil(w / TILE);
    const tiles = new Float64Array(tilesX * Math.ceil(h / TILE));
    let sum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(A.L[y * w + x] - B.L[y * w + x]);
        sum += d;
        tiles[Math.floor(y / TILE) * tilesX + Math.floor(x / TILE)] += d;
      }
    }
    let localMax = 0;
    for (let i = 0; i < tiles.length; i++) localMax = Math.max(localMax, tiles[i] / (TILE * TILE));
    return { mean: sum / (w * h), localMax, w, h };
  }, { a, b });
  for (const [name, kind, meanMin, localMin] of [['star', 'star', 0.0005, 0.3], ['planet', 'planet', 0.0002, null]]) {
    const pick = await nearSide(kind);
    await page.evaluate(({ kind, phase }) => {
      const sim = window.__sim;
      if (kind === 'planet') sim.set({ camera: { distance: 17, inclinationDeg: 90, azimuthDeg: 90 } });
      sim.addOrbiter({ kind, radius: 14, phase, inclinationDeg: 0, eccentricity: 0 });
    }, { kind, phase: pick.phase });
    await frames(3);
    const withBody = await shot(page);
    const stats = await renderStats(baseline, withBody);
    check(`bodies-render-${name}`, stats.mean > meanMin && (localMin === null || stats.localMax > localMin),
      `${name} at r=14 phase=${f(pick.phase, 3)} (z=${f(pick.z, 2)}): mean |dLum| over frame=${f(stats.mean, 5)} (threshold > ${meanMin}) ` +
      `max 8x8-tile |dLum|=${f(stats.localMax, 3)}${localMin === null ? ' (informational)' : ` (threshold > ${localMin})`}`);
    await page.evaluate((kind) => {
      window.__sim.clearOrbiters();
      if (kind === 'planet') window.__sim.set({ camera: { distance: 30, inclinationDeg: 80, azimuthDeg: 0 } });
    }, kind);
    await frames(3);
  }
  await page.evaluate(() => window.__sim.dropProbe({ position: [0, 0, 20], velocity: [0, 0, 0] }));
  await frames(3);
  const withProbe = await shot(page);
  const probeStats = await renderStats(baseline, withProbe);
  check('bodies-render-probe', probeStats.mean > 0.0001 && probeStats.localMax > 0.05,
    `probe at [0,0,20] paused: mean |dLum| over frame=${f(probeStats.mean, 5)} (threshold > 0.0001) ` +
    `max 8x8-tile |dLum|=${f(probeStats.localMax, 3)} (threshold > 0.05)`);
  await resetBodies(page);
  await restoreDefaults(page);

  // 6. performance (probe rendering included)
  await restoreDefaults(page);
  await page.evaluate(() => {
    window.__sim.clearProbes();
    window.__sim.dropProbe();
  });
  await sleep(300);
  const scaleBeforeBench = (await getState(page)).renderScale;
  const bench = await Promise.race([
    page.evaluate(() => window.__sim.benchmark(5)),
    sleep(40_000).then(() => { throw new Error('benchmark did not finish within 40 s'); }),
  ]);
  check('fps', bench.fps >= 120 && bench.width === 1280 && bench.height === 720,
    `frames=${bench.frames} seconds=${f(bench.seconds, 2)} fps=${f(bench.fps, 1)} size=${bench.width}x${bench.height} ` +
    `(threshold: fps >= 120 at 1280x720)`);

  // 6b. quality scaling (benchmark forces renderScale 1 internally - the fps check's 1280x720 proves that - then restores the prior scale)
  const scaleAfterBench = (await getState(page)).renderScale;
  check('quality-scaling-bench', typeof scaleAfterBench === 'number' && scaleAfterBench === scaleBeforeBench,
    `renderScale before benchmark=${scaleBeforeBench} after=${scaleAfterBench} (threshold: restored exactly)`);
  await setAndWait(page, { quality: 0.55 });
  const scalePinned = (await getState(page)).renderScale;
  check('quality-scaling-pin', typeof scalePinned === 'number' && Math.abs(scalePinned - 0.55) < 1e-6,
    `quality=0.55 -> renderScale=${scalePinned} (threshold: 0.55)`);
  await setAndWait(page, { quality: 'auto' });
  const autoState = await waitUntil(async () => {
    const s = await getState(page);
    return s.settings.quality === 'auto' && s.renderScale > 0.55 ? s : null;
  }, 8000, 250);
  const autoNow = autoState ?? await getState(page);
  check('quality-scaling-auto', !!autoState,
    `quality='auto' -> settings.quality=${autoNow.settings.quality} renderScale=${autoNow.renderScale} ` +
    `(threshold: auto restored and renderScale > 0.55 within 8 s)`);

  // 6c. performance with a full load: 8 probes + 8 orbiters (stars and planets) alive
  await restoreDefaults(page);
  await resetBodies(page);
  await page.evaluate(() => {
    for (let i = 0; i < 8; i++) {
      window.__sim.dropProbe({ position: [18 + 2 * i, 3, 6 - i], velocity: [0, 0.01, 0.05] });
      window.__sim.addOrbiter({ kind: i % 2 === 0 ? 'star' : 'planet', radius: 10 + i * 1.5 });
    }
  });
  await sleep(500);
  const loadedState = await getState(page);
  const benchLoaded = await Promise.race([
    page.evaluate(() => window.__sim.benchmark(5)),
    sleep(40_000).then(() => { throw new Error('loaded benchmark did not finish within 40 s'); }),
  ]);
  const loadedKinds = loadedState.orbiters.map((o) => o.kind);
  check('fps-loaded', benchLoaded.fps >= 120 && benchLoaded.width === 1280 && benchLoaded.height === 720 &&
      loadedState.probes.length === 8 && loadedState.orbiters.length === 8,
    `probes=${loadedState.probes.length} orbiters=${loadedState.orbiters.length} (${loadedKinds.filter((k) => k === 'star').length} star, ` +
    `${loadedKinds.filter((k) => k === 'planet').length} planet) frames=${benchLoaded.frames} seconds=${f(benchLoaded.seconds, 2)} ` +
    `fps=${f(benchLoaded.fps, 1)} size=${benchLoaded.width}x${benchLoaded.height} (threshold: 8+8 bodies, fps >= 120 at 1280x720)`);
  await resetBodies(page);
  await restoreDefaults(page);

  // 7. assets / network
  const isLocalData = (u) => u.startsWith('data:') || u.startsWith('blob:');
  const external = requests.filter((r) => !isLocalData(r.url) && new URL(r.url).origin !== ORIGIN);
  const media = requests.filter((r) => ['image', 'font', 'media'].includes(r.type) && !isLocalData(r.url));
  const bad = [...external, ...media.filter((m) => !external.includes(m))];
  check('no-external-requests', bad.length === 0,
    `${requests.length} requests, ${bad.length} offending (threshold: all same-origin ${ORIGIN}, no image/font/media except data:/blob:)` +
    bad.map((r) => `\n    ${r.type} ${r.url}`).join(''));
  const assets = listFiles(dist).filter((p) => ASSET_EXTS.has(extname(p).toLowerCase()));
  check('no-asset-files', assets.length === 0,
    `${assets.length} asset files in dist/ (threshold: 0)` + assets.map((p) => `\n    ${p}`).join(''));

  // 8. console
  check('console-errors', consoleErrors.length === 0,
    `${consoleErrors.length} errors (threshold: 0)` + consoleErrors.map((e) => `\n    ${e}`).join(''));
} catch (err) {
  console.error(`FAIL exception: ${err?.stack ?? err}`);
  results.push({ name: 'exception', ok: false });
} finally {
  clearTimeout(watchdog);
  await cleanup();
}

// 9. summary
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
