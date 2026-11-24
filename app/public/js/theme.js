// Material 3 Expressive theme: colour palettes, light/dark mode, xterm colours.
import { $, h } from './core.js';
import { open } from './workspace.js';

const M3_SEEDS = [
  { id: 'ember',    label: 'Ember',    swatch: '#ff9f62', cursor: '#ff9f62', darkBg: '#0b0d10', lightBg: '#ffffff' },
  { id: 'cobalt',   label: 'Cobalt',   swatch: '#82b4ff', cursor: '#82b4ff', darkBg: '#0a0c12', lightBg: '#ffffff' },
  { id: 'sage',     label: 'Sage',     swatch: '#6fdba6', cursor: '#6fdba6', darkBg: '#0a0e0c', lightBg: '#ffffff' },
  { id: 'amethyst', label: 'Amethyst', swatch: '#cfa6ff', cursor: '#cfa6ff', darkBg: '#0d0b11', lightBg: '#ffffff' },
  { id: 'rose',     label: 'Rose',     swatch: '#ff94ad', cursor: '#ff94ad', darkBg: '#0f0b0d', lightBg: '#ffffff' },
];
let themeSeed = 'ember';
let themeMode = 'dark';
const lightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : { matches: false, addEventListener() {} };

function resolvedScheme() {
  return themeMode === 'auto' ? (lightQuery.matches ? 'light' : 'dark') : themeMode;
}
function xtermTheme() {
  const seed = M3_SEEDS.find((s) => s.id === themeSeed) || M3_SEEDS[0];
  if (resolvedScheme() === 'light') {
    return {
      background: seed.lightBg,
      foreground: '#1d1b1a',
      cursor: seed.swatch,
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(120, 120, 140, 0.25)',
      black: '#1d1b1a', red: '#ba1a2b', green: '#137a43', yellow: '#946000',
      blue: '#1a5bc2', magenta: '#6b38b5', cyan: '#00687d', white: '#e6ddd5',
    };
  }
  return {
    background: seed.darkBg,
    foreground: '#e6eaf0',
    cursor: seed.cursor,
    cursorAccent: seed.darkBg,
    selectionBackground: '#394659',
  };
}
function applyTheme() {
  const scheme = resolvedScheme();
  document.documentElement.dataset.seed = themeSeed;
  document.documentElement.dataset.scheme = scheme;
  for (const b of document.querySelectorAll('#seedPicker .seed-dot')) {
    const on = b.dataset.seed === themeSeed;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
  for (const b of document.querySelectorAll('#modePicker button')) {
    const on = b.dataset.mode === themeMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
  const xt = xtermTheme();
  for (const e of open.values()) e.term.options.theme = xt;
  // Match the phone's status / address bar to the app.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) requestAnimationFrame(() => { meta.content = getComputedStyle(document.documentElement).getPropertyValue('--md-surf-low').trim() || meta.content; });
}
function initTheme() {
  try {
    const s = localStorage.getItem('m3Seed');
    const m = localStorage.getItem('m3Mode');
    if (M3_SEEDS.some((x) => x.id === s)) themeSeed = s;
    if (['dark', 'light', 'auto'].includes(m)) themeMode = m;
  } catch {}
  const sp = $('#seedPicker');
  if (sp) {
    sp.replaceChildren(...M3_SEEDS.map((s) =>
      h('button', {
        type: 'button', class: 'seed-dot', role: 'radio', 'data-seed': s.id, title: s.label, 'aria-label': s.label,
        style: `--dot-color:${s.swatch}`,
        onclick: () => { themeSeed = s.id; try { localStorage.setItem('m3Seed', s.id); } catch {} applyTheme(); },
      })));
  }
  for (const b of document.querySelectorAll('#modePicker button')) {
    b.addEventListener('click', () => {
      themeMode = b.dataset.mode;
      try { localStorage.setItem('m3Mode', themeMode); } catch {}
      applyTheme();
    });
  }
  $('#themeQuickToggle')?.addEventListener('click', () => {
    themeMode = resolvedScheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('m3Mode', themeMode); } catch {}
    applyTheme();
  });
  lightQuery.addEventListener?.('change', () => { if (themeMode === 'auto') applyTheme(); });
  applyTheme();
}

export { xtermTheme, initTheme };
