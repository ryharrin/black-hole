# Black hole simulator

**Live demo: <https://ryharrin.github.io/black-hole/>**

A real-time, fully procedural black hole in the browser (Three.js + a GLSL ray-marcher): a gravitationally lensed, turbulent accretion disk whose far side bends over and under the shadow, Doppler beaming, a procedural starfield and galaxy band with an Einstein ring, a photon ring, bloom and film grain, an orbit / zoom / fly-in camera with a time-dilated clock, and a probe you can drop in and watch freeze at the horizon. No image, model or font files; nothing is fetched at runtime.

## Requirements

- Node.js ≥ 20
- A WebGL2 browser (a GPU is strongly recommended)

## Commands

```sh
npm install        # once
npm run dev        # Vite dev server
npm run build      # production build into dist/
npm run preview    # serve dist/
npm test           # node:test unit tests (physics, presets, probe)
npm run verify     # headless Playwright checks against dist/ (run `npm run build` first)
```

`npm run verify` needs Chromium once: `npx playwright install chromium`. It launches it with GPU flags (Metal/ANGLE) and checks lensing, Doppler asymmetry, probes, presets, panel, clock, cinematic mode and a ≥ 120 FPS benchmark at 1280×720 including bloom and grain.

## Controls

| Input | Action |
| --- | --- |
| Drag | Orbit |
| Wheel | Zoom |
| Click canvas (no drag) | Release a probe at rest under the cursor; it falls straight in |
| `P` | Drop a probe from the default spot on the camera side |
| `1` / `2` | Add a star / a planet on an orbit at the **orbit radius** |
| `X` | Clear all orbiters |
| `↑` / `↓` (hold) | Fly in / out |
| `L` | Lensing on/off |
| `D` | Doppler on/off |
| `S` | Stars on/off |
| `B` | Bloom on/off |
| `G` | Film grain on/off |
| `H` | Hide/show all overlays (HUD and panel) |
| `C` | Cinematic mode (scripted ~90 s camera loop, entered at the loop phase nearest your current view with a 5 s blend; `C` exits) |

The right-hand panel has sliders for **mass**, **spin**, **disk temperature**, **disk tilt**, **lensing strength** and **time scale**; buttons for **Drop a probe**, **Cinematic** and hold-to-fly **Fly in / Fly out**; an **Orbiters** section with **Add star**, **Add planet**, **Clear** and sliders for **orbit decay** (0 = stable orbits, 1 = fast inspiral) and **orbit radius** (spawn semi-major axis, 8–30 M); toggles for lensing, Doppler, stars, bloom and grain; and the preset buttons. The HUD shows mass, Schwarzschild radius, the observer clock, FPS, for the latest probe its apparent radius and the time-dilation factor at that apparent radius, and for the latest orbiter a line such as `STAR · 5800 K · r 11.2 M · INSPIRAL · merge ~34 s · 2.4 orbits`. `window.__sim.getState()` keeps both the true and the apparent probe and orbiter states.

### Presets

| Preset | Look | Mass per scene unit |
| --- | --- | --- |
| Gargantua | spin 0.9, warm ~4500 K, slight tilt, slow time | 1×10⁸ M☉ |
| Sagittarius A* | spin 0.5, hotter (9000 K), tilted 20° | 4.3×10⁶ M☉ |
| Quiet | spin 0, cool dim 3000 K, flat, slow | 10 M☉ |

`window.__sim` exposes `set`, `applyPreset`, `getState`, `dropProbe`, `clearProbes`, `addOrbiter`, `clearOrbiters` and `benchmark` for scripting and tests. `getState().orbiters` lists the stars and planets (kind, style, temperature, `r`, `status`, `orbits`, `inspiralTime`, apparent view), and `set({ orbitDecay, orbitRadius })` changes the orbiter settings.

## Code layout

```
src/physics/   schwarzschild.js (pure formulas), body.js (shared RK4 + apparent view), probe.js, orbiters.js, presets.js   — no Three.js, unit-tested
src/shaders/   blackhole.js (ray-march GLSL), grain.js
src/scene/     renderer.js, post.js, quality.js
src/camera/    rig.js, cinematic.js, clock.js
src/ui/        panel.js, hud.js, style.css
src/main.js    integration, keyboard, window.__sim
tests/         node:test
```

The GLSL mirrors the formulas in `src/physics/schwarzschild.js`.

## Physics behind each effect

### Units and the Schwarzschild radius

Geometric units, $G = c = 1$. The scene mass is $M$ (slider, default 1), so every length and time scales with $M$. The horizon is at

$$r_s = 2M \qquad (= 2.95325\ \text{km} \times M/M_\odot).$$

The HUD converts with a per-preset "solar masses per scene unit": Sgr A* ($4.3\times10^6\,M_\odot$) has $r_s \approx 1.27\times10^7$ km. The black hole sits at the origin; the disk angular momentum is along $+y$ before tilt.

### Photon geodesics and lensing

Each pixel marches a ray through the scene. For a massless particle in Schwarzschild, the orbit equation $d^2u/d\varphi^2 = -u + 3Mu^2$ ($u = 1/r$) is equivalent to a Newtonian-like acceleration on the Cartesian position $\mathbf{x}$ with the conserved specific angular momentum $h = |\mathbf{x}\times\mathbf{v}|$:

$$\mathbf{a} = -\frac{3}{2}\,\frac{r_s\,h^2}{r^5}\,\mathbf{x} = -\frac{3M h^2}{r^5}\,\mathbf{x}$$

(the "$1.5\,h^2/r^5$" form when $r_s = 1$). Rays are integrated step by step; a ray that falls below $r_s$ is absorbed (the shadow), a ray that reaches the sky samples the star background, and a ray that crosses the disk plane picks up disk emission. Because rays bend around the hole, the far side of the disk shows up above and below the shadow. The **lensing strength** slider multiplies $\mathbf{a}$ (0 = straight lines, so the disk appears as a plain ellipse and the horizon as a black sphere of radius $r_s$).

### Shadow and photon ring

Circular photon orbits exist at $r = 3M$. Seen from far away, the shadow's edge is at the critical impact parameter

$$b_c = 3\sqrt{3}\,M \approx 5.196\,M,$$

larger than the photon sphere. Rays with $b$ just above $b_c$ wind around the photon sphere before escaping, so they spend a long time near $r = 3M$. The simulator accumulates a thin emission term for rays that linger near the photon sphere, which draws a bright ring at the shadow's rim. The near-opaque inner disk occludes the part of the ring it passes in front of.

### Einstein ring

For a source far behind the lens, the Einstein angle is

$$\theta_E = \sqrt{\frac{4M}{D}}$$

($D$ = distance to the lens). One designated bright star sits exactly behind the hole from the default camera pose (azimuth 0, inclination 80°), so you see a full ring of it; moving off-axis breaks it into arcs. The star is drawn as a small Gaussian disk (about 0.04° wide) with angular-covariance anti-aliasing, so the thin ring stays smooth instead of shimmering.

### Accretion disk and ISCO

The disk is a thin, differentially rotating sheet from the innermost stable circular orbit (ISCO) out to $20M$. Its texture is a 4-octave domain-warped fBm with clumpy filaments and dark lanes, filtered by an analytic ray-cone footprint (screen-space derivatives are unreliable inside the divergent ray-march disk crossings and caused small dash artifacts). Two staggered eddy textures, each with a lifetime of $40M$, crossfade; each is advected at the Keplerian $\Omega$, so differential rotation never winds a permanent pattern into concentric stripes over minutes. The inner disk is nearly opaque. For spin $a$ ($0 \le a < 1$, prograde) the Bardeen–Press–Teukolsky ISCO is

$$Z_1 = 1 + (1-a^2)^{1/3}\left[(1+a)^{1/3} + (1-a)^{1/3}\right],\quad Z_2 = \sqrt{3a^2 + Z_1^2},$$
$$r_{\rm ISCO} = M\left[3 + Z_2 - \sqrt{(3 - Z_1)(3 + Z_1 + 2Z_2)}\right],$$

giving $6M$ at $a = 0$, about $2.32M$ at $a = 0.9$, and tending to $M$ as $a \to 1$. The orbital speed seen by a static observer is $\beta = \sqrt{M/(r - 2M)}$ (capped at 0.999), and the angular velocity used for the flow pattern is $\Omega = \sqrt{M}/(r^{3/2} + a\sqrt{M})$. **Disk tilt** rotates the disk plane about the world $x$ axis.

### Doppler beaming and gravitational redshift

With $\gamma = 1/\sqrt{1-\beta^2}$ and $\cos\theta$ the angle between the gas velocity and the direction to the observer, the Doppler factor is

$$D = \frac{1}{\gamma\,(1 - \beta\cos\theta)},$$

which equals $\sqrt{(1+\beta)/(1-\beta)}$ for head-on approach, its inverse for recession, and $1/\gamma$ for transverse motion. Gravity adds $\sqrt{1 - 2M/r}$. The total frequency ratio is

$$g = \frac{\nu_{\rm obs}}{\nu_{\rm emit}} = \sqrt{1 - \frac{2M}{r}}\;\cdot D,$$

and the bolometric intensity scales as $I_{\rm obs} = g^4\,I_{\rm emit}$. The approaching side of the disk is therefore brighter and bluer, the receding side dimmer and redder. The **Doppler** toggle turns this factor off.

### Blackbody color

Disk color comes from a blackbody fit of the temperature (Tanner Helland's approximation, 1000–40000 K), converted to linear RGB and normalized to its brightest channel. The temperature at each point is shifted by $g$, which is why the approaching side turns bluer and the receding side redder.

### Time dilation clock and star stretching

A static observer at radius $r$ has $d\tau/dt = \sqrt{1 - 2M/r}$; the on-screen clock shows the camera's proper time $\tau$ against the far-away coordinate time $t$. When you fly toward the horizon, stars are stretched radially by about $\dfrac{1}{\sqrt{1-2M/r}}\,(1 + 3|\beta_r|)$ (capped at 8), where $\beta_r$ is your radial speed in units of $c$. This is an artistic approximation tied to the time-dilation factor, not a full aberration calculation.

### Probe: proper time, coordinate time and the horizon freeze

Probes move on a Schwarzschild geodesic parametrized by their own proper time $\tau$:

$$\ddot{\mathbf{x}} = -\frac{M}{r^3}\left(1 + \frac{3L^2}{r^2}\right)\mathbf{x},\qquad L = |\mathbf{x}\times\dot{\mathbf{x}}|,$$

integrated with RK4. The conserved energy $E^2 = \dot r^2 + (1 - 2M/r)(1 + L^2/r^2)$ gives the distant-observer clock

$$\frac{dt}{d\tau} = \frac{E}{1 - 2M/r},$$

which diverges at the horizon: the probe crosses $r_s$ after finite proper time (about $67M$ for the default drop) but infinite coordinate time. A probe is *captured* when its true $r \le r_s$.

What you see is not the true position. The simulator keeps the observer's time $T$, records the probe's (coordinate time, position) history, and draws the position the probe had at coordinate time $T$. Once the history ends, the apparent radius approaches the horizon exponentially,

$$r_{\rm app} = r_s + (r_{\rm last} - r_s)\,e^{-(T - t_{\rm last})/r_s},$$

so it creeps toward $r_s$ but never reaches it. The e-fold time is exactly $r_s = 2M$: the tortoise coordinate $r_* = r + 2M\ln(r/2M - 1)$ gives $r - 2M \propto e^{-t/2M}$ near the horizon. The apparent probe is dimmed and reddened by $\sqrt{1 - 2M/r_{\rm app}} \to 0$, stretched along the radial direction by a tidal-stretch factor (1 beyond $15M$ rising to 6 at $r_s$), and flagged *frozen* once $r_{\rm app} - r_s < 0.02\,r_s$. Light travel time from the probe to the camera is ignored.

### Probe spacecraft rendering

The probe is drawn as a small procedural spacecraft (about $0.32M$ half-length), never a sprite or model: a signed-distance-field capsule bus wrapped in gold foil, a nose cone, a high-gain dish, two solar-panel wings with a cell grid, blinking red/green navigation lights and a blue engine glow with a short plume. Each ray's step is tested against a cheap bounding sphere, and the detailed SDF is marched (at most 24 steps) only when the ray segment hits it, so the ship is lensed, shows multiple images and is occluded by the horizon and the disk like everything else. It is lit by a key light from the inner disk (direction toward the hole, colour of the disk's blackbody temperature) plus a faint cool ambient. Redshift dims and reddens it, tidal stretch elongates it along the radial axis near the horizon, and the nose points along its local velocity.

### Stars and planets: orbits and decay

Stars and planets follow the same proper-time Schwarzschild geodesic as probes (the Binet-form acceleration above, RK4), so a circular orbit exists for $r > 3M$ with $d\mathbf{x}/d\tau = L/r = \sqrt{M/(r - 3M)}$, and it is stable only for $r \ge 6M$ (the Schwarzschild ISCO). A body that loses energy slides inward through a sequence of nearly circular orbits until it reaches the ISCO, where the effective potential has no minimum, and then **plunges** across the horizon. New bodies start prograde in the (tilted) disk sense: angular momentum along $+y$ rotated about $x$ by the disk tilt, then a random inclination up to $\pm 12^\circ$ and eccentricity up to $0.08$; the **orbit radius** slider is the semi-major axis in units of $M$.

Real orbital decay comes from gravitational radiation. For a circular orbit of radius $a$ around mass $M$ with mass ratio $q = \mu/M$, Peters' formulae give

$$\frac{da}{dt} = -\frac{64}{5}\,\frac{q\,M^3}{a^3}, \qquad T_{\rm inspiral} = \frac{5\,a^4}{256\,q\,M^3},$$

and the simulator applies a radiation-reaction acceleration antiparallel to the velocity,

$$\mathbf{a}_{\rm rr} = -\frac{32}{5}\,\frac{q\,M^4}{r^5\,|\mathbf{v}|^2}\,\mathbf{v},$$

which removes specific energy at the Peters rate $dE/dt = \mathbf{a}_{\rm rr}\cdot\mathbf{v} = -\tfrac{32}{5}\,q M^4/r^5$ and so reproduces $da/dt \propto a^{-3}$ for a near-circular orbit (the tests check the $r^{-3}$ scaling, the merge time against $T_{\rm inspiral}$, and the angular-momentum tilt). The formula is an adiabatic, quasi-circular result, so the force is faded out smoothly between $6M$ and $3.5M$; otherwise it would brake a plunging body to a halt. The `orbiter.inspiralTime` field is $T_{\rm inspiral}$ at the current radius.

**Why $q$ is exaggerated.** A real star around a supermassive hole has $q \sim 10^{-6}$ or smaller; at $14M$ that gives $T \sim 10^{9}M$, about a year of watching even at the simulator's 24 time units per second, and real orbits sit much farther out where $T \propto a^4$ grows into millions of years. The **orbit decay** slider (0–1) maps to $q = 4.5\,x^{2.2}$ (0 = no decay, stable orbits; default 0.35 gives $q \approx 0.45$): from $14M$ at time scale 1 a body completes about seven orbits and is captured after roughly a minute at 0.35, within about 10 s at 1, and survives well beyond 5 minutes at 0.05. The body's `status` is `orbiting` (no decay, or $r > 1.5\,r_{\rm ISCO} = 9M$), `inspiral` ($6M$–$9M$), `plunging` ($r < 6M$) or `captured` (crossed the horizon), and `orbits` counts the azimuth swept about its angular momentum axis.

**What you see.** Each body carries `apparent.velocity`, its velocity relative to a static observer at its radius, as a fraction of $c$: radial $\dot r/E$ and tangential $(L/r)\sqrt{1-2M/r}/E$ (with $E$ the geodesic's specific energy, $E^2 = \dot r^2 + (1-2M/r)(1+L^2/r^2)$). The shader uses it for the total frequency ratio

$$g = \frac{\sqrt{1 - 2M/r}\,\sqrt{1 - \beta^2}}{1 - \mathbf{v}\cdot\mathbf{n}},$$

with $\mathbf{n}$ the unit vector from the body toward the camera ($-$ the ray direction). A star's blackbody temperature is multiplied by $g$ and its intensity by $g^4$, so the side moving toward you is bluer and brighter, the side moving away redder and dimmer, and a body deep in the potential well reddens and fades. Near the horizon the body is stretched along the radial axis by the same visual tidal factor as probes (1 beyond $15M$, rising to 6 at $r_s$). Its drawn position is the *apparent* one: the history replayed against coordinate time, exactly as for probes, so a captured star or planet creeps toward $r_s$ with e-fold time $2M$, never crosses it, and ends up frozen, dark red and stretched at the horizon.

**Star halos.** Each star glows through a softened $1/d^3$ emissivity around it, $j(d) \propto (d^2 + a^2)^{-3/2} - j_{\rm edge}$ with $a^2 = 0.5R^2$, cut to zero at $4.5R$ (the constant $j_{\rm edge}$ makes it reach zero exactly there, so the glow has no visible edge). Its line integral along each straight ray segment has the closed form $\int (s^2 + A^2)^{-3/2}\,ds = s/(A^2\sqrt{A^2 + s^2})$, so the halo is exact per segment and continuous from pixel to pixel. Halos from different stars add, so overlapping stars blend, and the part of a halo behind the accretion disk is dimmed by the disk's opacity like the star itself. Wider glow comes from the bloom pass.

### Spin: an approximation, not Kerr

Spin is **not** a Kerr solution. It affects the simulation in three ways only: the ISCO from the Bardeen formula above, the Keplerian angular velocity $\Omega = \sqrt{M}/(r^{3/2} + a\sqrt{M})$ for the disk flow, and a small frame-dragging-like azimuthal deflection term added to the photon acceleration, scaled by spin, which gives the asymmetric, flattened shadow. Photon trajectories, the shadow shape and the redshift remain Schwarzschild-based; there is no ergosphere, no Kerr geodesic integration and no exact $g$ for Kerr.

### Post-processing

The scene renders to a floating-point target, then passes through an `UnrealBloomPass` (threshold set so only the disk, photon ring and bright stars glow), an animated film-grain pass, and Three.js's `OutputPass` for color conversion with a hue-preserving luminance compression (bright areas roll off without shifting color). Bloom and grain can be toggled (`B`, `G`) and are always on during `benchmark()`.

### Automatic quality scaling

A quality scaler watches a rolling FPS average. If it falls below 50 for over a second, the render scale steps down (1 → 0.85 → 0.7 → 0.55) and the ray-step budget shrinks; it steps back up after FPS stays above 90 for 3 seconds. Setting `quality` to a number (0.5–1) pins the scale. The HUD shows the current scale.
