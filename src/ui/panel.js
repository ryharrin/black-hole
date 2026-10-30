// Control panel docked on the right edge. Plain DOM, no dependencies.
//
// createPanel(host, { settings, ranges, presets, onChange, onPreset, onDropProbe, onAddOrbiter,
//                     onClearOrbiters, onCinematic, onFlight, onToggle }) -> { sync(settings), setVisible(bool) }

const SLIDER_KEYS = ['mass', 'spin', 'diskTemp', 'diskTilt', 'lensingStrength', 'timeScale'];
const SLIDER_FALLBACK_LABEL = {
  mass: 'Mass',
  spin: 'Spin',
  diskTemp: 'Disk temperature',
  diskTilt: 'Disk tilt',
  lensingStrength: 'Lensing strength',
  timeScale: 'Time scale',
  orbitDecay: 'Orbit decay',
  orbitRadius: 'Orbit radius',
};
const TOGGLES = [
  { key: 'lensing', label: 'Lensing', hint: 'L' },
  { key: 'doppler', label: 'Doppler', hint: 'D' },
  { key: 'stars', label: 'Stars', hint: 'S' },
  { key: 'bloom', label: 'Bloom', hint: 'B' },
  { key: 'grain', label: 'Grain', hint: 'G' },
];

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHEVRON_IN = 'M2 3.5 L6 8 L10 3.5 M2 7.5 L6 12 L10 7.5';
const CHEVRON_OUT = 'M2 8.5 L6 4 L10 8.5 M2 12.5 L6 8 L10 12.5';

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function chevron(path) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 16');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

function decimalsOf(step) {
  if (!Number.isFinite(step) || step <= 0) return 2;
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function formatValue(value, decimals, unit) {
  const number = Number(value).toFixed(decimals);
  if (!unit) return number;
  return /^[A-Za-z]/.test(unit) ? `${number} ${unit}` : `${number}${unit}`;
}

export function createPanel(host, options) {
  const {
    settings: initial,
    ranges = {},
    presets = {},
    onChange = () => {},
    onPreset = () => {},
    onDropProbe = () => {},
    onAddOrbiter = () => {},
    onClearOrbiters = () => {},
    onCinematic = () => {},
    onFlight = () => {},
    onToggle = () => {},
  } = options;

  let current = initial || {};

  const root = h('aside', { id: 'panel', 'aria-label': 'Simulation controls' });

  // --- header (collapse) ---
  const headerButton = h('button', {
    type: 'button',
    class: 'panel-header',
    'aria-expanded': 'true',
    'aria-controls': 'panel-body',
  });
  headerButton.append(
    h('span', { class: 'panel-title', text: 'Controls' }),
    h('span', { class: 'panel-caret', 'aria-hidden': 'true' }),
  );
  const body = h('div', { id: 'panel-body', class: 'panel-body' });
  root.append(headerButton, body);
  headerButton.addEventListener('click', () => {
    const collapsed = root.classList.toggle('collapsed');
    headerButton.setAttribute('aria-expanded', String(!collapsed));
  });

  // --- presets ---
  const presetButtons = new Map();
  const presetRow = h('div', { class: 'preset-row', role: 'group', 'aria-label': 'Presets' });
  for (const [key, preset] of Object.entries(presets)) {
    const button = h('button', {
      type: 'button',
      id: `preset-${key}`,
      class: 'btn preset',
      title: preset.description || preset.label || key,
      'aria-pressed': 'false',
      text: preset.label || key,
    });
    button.addEventListener('click', () => onPreset(key));
    presetButtons.set(key, button);
    presetRow.append(button);
  }
  body.append(h('div', { class: 'group' }, [h('div', { class: 'group-label', text: 'Preset' }), presetRow]));

  // --- sliders ---
  const sliders = [];
  const addSlider = (group, key) => {
    const range = ranges[key];
    if (!range) return;
    const decimals = decimalsOf(range.step);
    const label = range.label || SLIDER_FALLBACK_LABEL[key] || key;
    const input = h('input', {
      type: 'range',
      id: `ctl-${key}`,
      min: range.min,
      max: range.max,
      step: range.step,
      'aria-label': label,
    });
    const valueLabel = h('span', { class: 'slider-value' });
    const entry = { key, range, decimals, input, valueLabel, dragging: false, last: NaN };
    const refresh = (value) => {
      if (value === entry.last) return;
      entry.last = value;
      valueLabel.textContent = formatValue(value, decimals, range.unit);
      const span = range.max - range.min;
      const pct = span > 0 ? ((value - range.min) / span) * 100 : 0;
      input.style.setProperty('--p', `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`);
    };
    entry.refresh = refresh;
    input.addEventListener('input', () => {
      const value = Number(input.value);
      refresh(value);
      onChange({ [key]: value });
    });
    input.addEventListener('pointerdown', () => { entry.dragging = true; });
    const endDrag = () => {
      if (!entry.dragging) return;
      entry.dragging = false;
      // Hand the keyboard back to the simulation shortcuts after a mouse/touch drag.
      input.blur();
    };
    input.addEventListener('pointerup', endDrag);
    input.addEventListener('pointercancel', endDrag);
    input.addEventListener('dblclick', () => {
      // Double-click resets to default.
      if (range.default === undefined) return;
      input.value = String(range.default);
      refresh(Number(range.default));
      onChange({ [key]: Number(range.default) });
    });
    sliders.push(entry);
    group.append(
      h('div', { class: 'slider-row' }, [
        h('label', { class: 'slider-head', for: `ctl-${key}` }, [h('span', { class: 'slider-label', text: label }), valueLabel]),
        input,
      ]),
    );
  };
  const sliderGroup = h('div', { class: 'group sliders' });
  sliderGroup.append(h('div', { class: 'group-label', text: 'Parameters' }));
  for (const key of SLIDER_KEYS) addSlider(sliderGroup, key);
  body.append(sliderGroup);

  // --- orbiters ---
  const addStarButton = h('button', { type: 'button', id: 'add-star', class: 'btn action' }, [
    h('span', { text: 'Add star' }),
    h('kbd', { text: '1' }),
  ]);
  addStarButton.addEventListener('click', () => onAddOrbiter('star'));
  const addPlanetButton = h('button', { type: 'button', id: 'add-planet', class: 'btn action' }, [
    h('span', { text: 'Add planet' }),
    h('kbd', { text: '2' }),
  ]);
  addPlanetButton.addEventListener('click', () => onAddOrbiter('planet'));
  const clearOrbitersButton = h('button', { type: 'button', id: 'clear-orbiters', class: 'btn action' }, [
    h('span', { text: 'Clear orbiters' }),
    h('kbd', { text: 'X' }),
  ]);
  clearOrbitersButton.addEventListener('click', () => onClearOrbiters());
  const orbiterGroup = h('div', { class: 'group sliders orbiters' }, [
    h('div', { class: 'group-label', text: 'Orbiters' }),
    h('div', { class: 'orbiter-grid' }, [addStarButton, addPlanetButton]),
    h('div', { class: 'orbiter-clear' }, [clearOrbitersButton]),
  ]);
  for (const key of ['orbitDecay', 'orbitRadius']) addSlider(orbiterGroup, key);
  body.append(orbiterGroup);

  // --- toggles ---
  const toggleButtons = new Map();
  const toggleRow = h('div', { class: 'toggle-row', role: 'group', 'aria-label': 'Rendering toggles' });
  for (const { key, label, hint } of TOGGLES) {
    const button = h('button', {
      type: 'button',
      id: `tog-${key}`,
      class: 'btn chip',
      role: 'switch',
      'aria-checked': 'false',
    });
    button.append(h('i', { class: 'led', 'aria-hidden': 'true' }), h('span', { text: label }), h('kbd', { text: hint }));
    button.addEventListener('click', () => onToggle(key));
    toggleButtons.set(key, button);
    toggleRow.append(button);
  }
  body.append(h('div', { class: 'group' }, [h('div', { class: 'group-label', text: 'Rendering' }), toggleRow]));

  // --- actions ---
  const dropButton = h('button', { type: 'button', id: 'drop-probe', class: 'btn action' }, [
    h('span', { text: 'Drop a probe' }),
    h('kbd', { text: 'P' }),
  ]);
  dropButton.addEventListener('click', () => onDropProbe());

  const cinematicButton = h('button', { type: 'button', id: 'cinematic', class: 'btn action', 'aria-pressed': 'false' }, [
    h('span', { text: 'Cinematic' }),
    h('kbd', { text: 'C' }),
  ]);
  cinematicButton.addEventListener('click', () => onCinematic(!current.cinematic));

  const flyIn = h('button', { type: 'button', id: 'fly-in', class: 'btn fly', 'aria-label': 'Hold to fly in toward the horizon' }, [
    chevron(CHEVRON_IN),
    h('span', { text: 'Fly in' }),
  ]);
  const flyOut = h('button', { type: 'button', id: 'fly-out', class: 'btn fly', 'aria-label': 'Hold to fly out away from the horizon' }, [
    chevron(CHEVRON_OUT),
    h('span', { text: 'Fly out' }),
  ]);
  const flyers = [
    { button: flyIn, dir: -1, held: false },
    { button: flyOut, dir: 1, held: false },
  ];
  const release = (flyer) => {
    if (!flyer.held) return;
    flyer.held = false;
    flyer.button.classList.remove('held');
    onFlight(0);
  };
  const releaseAll = () => flyers.forEach(release);
  for (const flyer of flyers) {
    const { button, dir } = flyer;
    const press = () => {
      if (flyer.held) return;
      flyer.held = true;
      button.classList.add('held');
      onFlight(dir);
    };
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      press();
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      button.addEventListener(type, () => release(flyer));
    }
    button.addEventListener('blur', () => release(flyer));
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    button.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        press();
      }
    });
    button.addEventListener('keyup', (event) => {
      if (event.key === ' ' || event.key === 'Enter') release(flyer);
    });
  }
  window.addEventListener('blur', releaseAll);

  body.append(
    h('div', { class: 'group' }, [
      h('div', { class: 'group-label', text: 'Actions' }),
      h('div', { class: 'action-grid' }, [dropButton, cinematicButton]),
      h('div', { class: 'fly-row' }, [flyIn, flyOut]),
    ]),
  );

  // Keep keyboard shortcuts from firing while a slider is being adjusted with the keyboard.
  const stopFromInputs = (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') event.stopPropagation();
  };
  root.addEventListener('keydown', stopFromInputs);
  root.addEventListener('keyup', stopFromInputs);

  // Mouse presses on buttons should not steal keyboard focus from the sim shortcuts.
  root.addEventListener('mousedown', (event) => {
    const button = event.target.closest && event.target.closest('button');
    if (button && button !== headerButton) event.preventDefault();
  });

  host.append(root);

  // --- cinematic exit hint (independent of panel visibility) ---
  const hint = h('div', { id: 'cinematic-hint', 'aria-hidden': 'true', text: 'exit cinematic (C)' });
  host.append(hint);
  let hintTimer = 0;
  let hintShown = false;
  const showHint = (on) => {
    if (on === hintShown) return;
    hintShown = on;
    clearTimeout(hintTimer);
    if (on) {
      hint.classList.add('visible');
      hintTimer = setTimeout(() => hint.classList.remove('visible'), 2000);
    } else {
      hint.classList.remove('visible');
    }
  };

  function sync(next) {
    current = next;
    for (const entry of sliders) {
      const value = next[entry.key];
      if (typeof value !== 'number') continue;
      if (!entry.dragging && Number(entry.input.value) !== value) entry.input.value = String(value);
      entry.refresh(value);
    }
    for (const [key, button] of presetButtons) {
      const active = next.preset === key;
      if (button.classList.contains('active') !== active) {
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      }
    }
    for (const [key, button] of toggleButtons) {
      const on = Boolean(next[key]);
      if (button.classList.contains('active') !== on) {
        button.classList.toggle('active', on);
        button.setAttribute('aria-checked', String(on));
      }
    }
    const cinematic = Boolean(next.cinematic);
    if (cinematicButton.classList.contains('active') !== cinematic) {
      cinematicButton.classList.toggle('active', cinematic);
      cinematicButton.setAttribute('aria-pressed', String(cinematic));
    }
    showHint(cinematic && next.hud !== false);
  }

  sync(current);

  return {
    sync,
    setVisible(visible) {
      root.style.display = visible ? '' : 'none';
      if (!visible) releaseAll();
    },
  };
}
