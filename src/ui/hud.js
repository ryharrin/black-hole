// HUD readouts: top-left telemetry, bottom-left dual clock. Plain DOM.
//
// createHud(host) -> { update(readouts), setVisible(bool) }
// readouts = { mass, massSolar, rs, rsKm, fps, renderScale, presetLabel,
//              clock: { properTime, coordTime, rate },
//              probe: null | { r, timeDilation, redshift, captured, frozen, apparentR },
//              orbiters: { count, latest: null | { kind, style, temperature, r, status, orbits,
//                                                  inspiralSeconds, redshift } } }

const SUPERSCRIPT = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

function superscript(n) {
  return String(n).replace(/[-0-9]/g, (c) => SUPERSCRIPT[c]);
}

// 4.30×10⁶ for very large/small values; plain fixed notation otherwise.
export function formatSci(x, digits = 2) {
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  const abs = Math.abs(x);
  if (abs >= 1e4 || abs < 1e-2) {
    let exp = Math.floor(Math.log10(abs));
    let mantissa = x / 10 ** exp;
    if (Math.abs(Number(mantissa.toFixed(digits))) >= 10) {
      mantissa /= 10;
      exp += 1;
    }
    return `${mantissa.toFixed(digits)}×10${superscript(exp)}`;
  }
  if (abs >= 1000) return x.toFixed(0);
  return x.toFixed(digits);
}

function formatFixed(x, digits) {
  return Number.isFinite(x) ? x.toFixed(digits) : '—';
}

const PLANET_STYLE_LABEL = { gas: 'GAS GIANT', rocky: 'ROCKY', ice: 'ICE' };

function formatMerge(seconds, status) {
  if (status === 'captured') return 'merged';
  if (seconds === Infinity) return 'stable';
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return 'merge < 1 s';
  if (seconds < 120) return `merge ~${Math.round(seconds)} s`;
  if (seconds < 7200) return `merge ~${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)} min`;
  return 'merge > 2 h';
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  return `${seconds.toFixed(1)} s`;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node._text !== text) {
    node._text = text;
    node.textContent = text;
  }
}

function setClass(node, name, on) {
  if (node._cls === undefined) node._cls = {};
  if (node._cls[name] !== on) {
    node._cls[name] = on;
    node.classList.toggle(name, on);
  }
}

function row(label, raw = false) {
  const value = h('span', 'v', '—');
  const node = h('div', 'hud-row');
  node.append(h('span', raw ? 'k raw' : 'k', label), value);
  return { node, value };
}

export function createHud(host) {
  const root = h('div');
  root.id = 'hud';
  root.setAttribute('aria-label', 'Simulation readouts');

  // --- top-left: black hole + probe ---
  const top = h('section', 'hud-block hud-top');
  const preset = h('div', 'hud-title', '—');
  const eyebrow = h('div', 'hud-eyebrow');
  eyebrow.append(h('i', 'hud-dot'), h('span', '', 'Schwarzschild'));
  top.append(eyebrow, preset);

  const massRow = row('mass');
  const rsRow = row('r', true);
  rsRow.node.firstChild.innerHTML = 'r<sub>s</sub>';
  const perfRow = row('render');
  top.append(massRow.node, rsRow.node, perfRow.node);

  const probeHead = h('div', 'hud-subhead');
  const probeLabel = h('span', '', 'Probe');
  const probeStatus = h('span', 'hud-status');
  probeHead.append(probeLabel, probeStatus);
  const probeIdle = h('div', 'hud-idle', 'none released · press P');
  const probeRows = h('div', 'hud-probe-rows');
  const rRow = row('r', true);
  const dilRow = row('d\u03c4/dt', true);
  const redRow = row('redshift');
  probeRows.append(rRow.node, dilRow.node, redRow.node);
  top.append(probeHead, probeIdle, probeRows);

  const orbHead = h('div', 'hud-subhead');
  const orbLabel = h('span', '', 'Orbiters');
  const orbStatus = h('span', 'hud-status');
  orbHead.append(orbLabel, orbStatus);
  const orbRows = h('div', 'hud-orbiters');
  const orbKind = h('div', 'hud-orbiter-head');
  const orbKindText = h('span', 'hud-orbiter-kind');
  const orbTemp = h('span', 'hud-orbiter-temp');
  orbKind.append(orbKindText, orbTemp);
  const orbRRow = row('r', true);
  const orbMergeRow = row('fate');
  const orbOrbitsRow = row('orbits');
  orbRows.append(orbKind, orbRRow.node, orbMergeRow.node, orbOrbitsRow.node);
  setClass(orbHead, 'hidden', true);
  setClass(orbRows, 'hidden', true);
  top.append(orbHead, orbRows);

  // --- bottom-left: dual clock ---
  const bottom = h('section', 'hud-block hud-clock');
  bottom.append(h('div', 'hud-subhead no-rule', 'Clocks'));
  const yourRow = row('your clock');
  const farRow = row('far-away clock');
  const gauge = h('div', 'hud-gauge');
  const gaugeFill = h('div', 'hud-gauge-fill');
  gauge.append(gaugeFill);
  const rateRow = row('your rate');
  bottom.append(yourRow.node, farRow.node, gauge, rateRow.node);

  root.append(top, bottom);
  host.append(root);

  let lastRate = NaN;

  return {
    update(r) {
      if (!r) return;
      setText(preset, String(r.presetLabel || 'Custom'));
      setText(massRow.value, `${formatSci(r.mass)} M · ${formatSci(r.massSolar)} M☉`);
      setText(rsRow.value, `${formatSci(r.rs)} M · ${formatSci(r.rsKm)} km`);
      const scale = Number.isFinite(r.renderScale) ? `${Math.round(r.renderScale * 100)}%` : '—';
      setText(perfRow.value, `${Number.isFinite(r.fps) ? Math.round(r.fps) : '—'} fps · ${scale}`);

      const p = r.probe;
      setClass(probeIdle, 'hidden', Boolean(p));
      setClass(probeRows, 'hidden', !p);
      setClass(probeStatus, 'hidden', !p);
      if (p) {
        const radius = Number.isFinite(p.apparentR) ? p.apparentR : p.r;
        setText(rRow.value, `${formatFixed(radius, 2)} M`);
        setText(dilRow.value, formatFixed(p.timeDilation, 4));
        const g = p.redshift;
        let z;
        if (!Number.isFinite(g)) z = '—';
        else if (g < 1e-3) z = 'z > 999';
        else z = `z ${(1 / g - 1).toFixed(2)} (×${g.toFixed(3)})`;
        setText(redRow.value, z);
        setText(probeStatus, p.frozen ? 'frozen at horizon' : 'falling');
        setClass(probeStatus, 'frozen', Boolean(p.frozen));
      }

      const o = r.orbiters;
      const latest = o && o.count > 0 ? o.latest : null;
      setClass(orbHead, 'hidden', !latest);
      setClass(orbRows, 'hidden', !latest);
      if (latest) {
        setText(orbLabel, `Orbiters · ${o.count}`);
        const status = String(latest.status || '').toUpperCase();
        setText(orbStatus, status);
        setClass(orbStatus, 'orbiting', latest.status === 'orbiting');
        setClass(orbStatus, 'inspiral', latest.status === 'inspiral');
        setClass(orbStatus, 'plunging', latest.status === 'plunging');
        setClass(orbStatus, 'captured', latest.status === 'captured');
        if (latest.kind === 'planet') {
          setText(orbKindText, `Planet · ${PLANET_STYLE_LABEL[latest.style] || String(latest.style || '').toUpperCase()}`);
          setText(orbTemp, '');
        } else {
          setText(orbKindText, 'Star');
          const t = latest.temperature;
          setText(orbTemp, Number.isFinite(t) ? `${Math.round(t / 10) * 10} K` : '');
        }
        setText(orbRRow.value, `${formatFixed(latest.r, 1)} M`);
        setText(orbMergeRow.value, formatMerge(latest.inspiralSeconds, latest.status));
        setText(orbOrbitsRow.value, formatFixed(latest.orbits, 1));
      }

      const c = r.clock;
      if (c) {
        setText(yourRow.value, formatClock(c.properTime));
        setText(farRow.value, formatClock(c.coordTime));
        const pct = Number.isFinite(c.rate) ? Math.max(0, Math.min(1, c.rate)) * 100 : NaN;
        setText(rateRow.value, Number.isFinite(pct) ? `${pct.toFixed(pct < 10 ? 2 : 1)}%` : '—');
        if (pct !== lastRate) {
          lastRate = pct;
          gaugeFill.style.transform = `scaleX(${Number.isFinite(pct) ? (pct / 100).toFixed(4) : 0})`;
        }
      }
    },
    setVisible(visible) {
      root.style.display = visible ? '' : 'none';
    },
  };
}
