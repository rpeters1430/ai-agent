// Terminal tabs: xterm + WebSocket per tmux session, split view, mobile key bar, paste, font size.
import { state } from './state.js';
import { $, api, h, m3Prompt, showDialog } from './core.js';
import { xtermTheme } from './theme.js';
import { loadSessions, open, sessions } from './workspace.js';
import { closeMobileSheet, isMobile } from './nav.js';

async function launch(opts) {
  const { name } = await api('POST', '/api/sessions', opts);
  await loadSessions();
  const s = sessions.find((x) => x.name === name);
  attach(name, s?.label || name);
}

let termFontSize = 13;

function setFontSize(next, focus = true) {
  termFontSize = Math.max(10, Math.min(22, next));
  try { localStorage.setItem('termFontSize', String(termFontSize)); } catch {}
  for (const e of open.values()) e.term.options.fontSize = termFontSize;
  const cur = open.get(state.active);
  if (cur) requestAnimationFrame(() => { try { cur.fit.fit(); } catch {} if (focus) cur.term.focus(); });
}

// Touch: one-finger swipe scrolls (mouse wheel to tmux / the app, or xterm's scrollback),
// with a little momentum; two-finger pinch changes the font size. Taps fall through and focus the terminal.
function attachTouch(term, el) {
  let startY = 0, lastY = 0, lastT = 0, acc = 0, vel = 0, moved = false, raf = 0;
  let pinch0 = 0, pinchFont = 0;
  const lineH = () => Math.max(8, el.clientHeight / Math.max(1, term.rows));
  const wheel = (lines) => {
    if (!lines) return;
    const mouse = term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none';
    if (mouse) {
      const e = [...open.values()].find((x) => x.term === term);
      if (e?.ws?.readyState !== 1) return;
      const btn = lines < 0 ? 64 : 65;   // SGR wheel up / down
      const col = Math.max(1, Math.floor(term.cols / 2)), row = Math.max(1, Math.floor(term.rows / 2));
      const seq = `\x1b[<${btn};${col};${row}M`.repeat(Math.min(Math.abs(lines), 12));
      e.ws.send(JSON.stringify({ t: 'i', d: seq }));
    } else {
      term.scrollLines(lines);
    }
  };
  const step = (dy) => {
    acc += dy;
    const lh = lineH();
    const n = Math.trunc(acc / lh);
    if (n) { acc -= n * lh; wheel(-n); }   // finger down = content moves down = scroll up
  };
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.addEventListener('touchstart', (ev) => {
    cancelAnimationFrame(raf);
    if (ev.touches.length === 2) { pinch0 = dist(ev.touches); pinchFont = termFontSize; moved = true; return; }
    if (ev.touches.length !== 1) return;
    startY = lastY = ev.touches[0].clientY; lastT = performance.now(); acc = 0; vel = 0; moved = false; pinch0 = 0;
  }, { passive: true });
  el.addEventListener('touchmove', (ev) => {
    if (ev.touches.length === 2 && pinch0) {
      ev.preventDefault();
      const next = Math.round(pinchFont * (dist(ev.touches) / pinch0));
      if (next !== termFontSize && next >= 10 && next <= 22) setFontSize(next, false);
      return;
    }
    if (ev.touches.length !== 1 || pinch0) return;
    const y = ev.touches[0].clientY, now = performance.now();
    if (!moved && Math.abs(y - startY) < 8) return;
    moved = true;
    ev.preventDefault();
    const dy = y - lastY;
    vel = dy / Math.max(1, now - lastT);
    lastY = y; lastT = now;
    step(dy);
  }, { passive: false });
  el.addEventListener('touchend', (ev) => {
    if (pinch0) { if (ev.touches.length === 0) pinch0 = 0; return; }
    if (!moved) return;                        // a tap: let xterm focus / open the keyboard
    ev.preventDefault();                       // a swipe: don't turn it into a click
    if (Math.abs(vel) < 0.3) return;
    let v = vel * 16, last = performance.now();
    const glide = (t) => {
      const dt = Math.min(48, t - last); last = t;
      v *= Math.pow(0.95, dt / 16);
      if (Math.abs(v) < 0.6) return;
      step(v * dt / 16);
      raf = requestAnimationFrame(glide);
    };
    raf = requestAnimationFrame(glide);
  }, { passive: false });
}

function sendRawToActive(seq) {
  const e = open.get(state.active);
  if (!e || e.ws?.readyState !== 1) return;
  e.ws.send(JSON.stringify({ t: 'i', d: seq }));
  e.term.focus();
}

// Sticky modifiers for the on-screen keybar: tap = next key only, double-tap = locked until tapped again.
const mods = { ctrl: 0, alt: 0 };   // 0 off, 1 one-shot, 2 locked
const modBtns = {};
function renderMods() {
  for (const [k, b] of Object.entries(modBtns)) {
    b.classList.toggle('armed', mods[k] === 1);
    b.classList.toggle('locked', mods[k] === 2);
    b.setAttribute('aria-pressed', String(mods[k] > 0));
  }
}
function consumeMods() {
  for (const k of Object.keys(mods)) if (mods[k] === 1) mods[k] = 0;
  renderMods();
}
// Apply armed Ctrl/Alt to input typed on the phone keyboard (or a keybar key).
function applyMods(d) {
  if (!mods.ctrl && !mods.alt) return d;
  if (d.length !== 1 && !/^\x1b\[[ABCD]$/.test(d)) return d;          // leave pastes / terminal replies alone
  let out = d;
  if (mods.ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);       // A-Z [ \ ] ^ _
    else if (d === ' ' || d === '2' || d === '@') out = '\x00';
    else if (d === '/' || d === '7') out = '\x1f';
    else if (d === '?' || d === '8') out = '\x7f';
  } else if (mods.ctrl && /^\x1b\[[ABCD]$/.test(d)) {
    out = `\x1b[1;5${d[2]}`;                                           // Ctrl+arrow (word jump)
  }
  if (mods.alt) out = '\x1b' + out;
  consumeMods();
  return out;
}

function initKeybar() {
  const keys = [
    ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', 'mod:ctrl'], ['Alt', 'mod:alt'],
    ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
    '|',
    ['^C', '\x03'], ['^D', '\x04'], ['^R', '\x12'], ['^L', '\x0c'], ['^Z', '\x1a'], ['S-Tab', '\x1b[Z'],
    '|',
    ['/', '/'], ['-', '-'], ['|', '|'], ['~', '~'], ['`', '`'],
    '|',
    ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'], ['⏎', '\r'],
    '|',
    ['A−', 'font:-1'], ['A+', 'font:1'],
  ];
  const bar = $('#keybar'), btn = $('#keysToggle');
  const lastTap = {};
  bar.replaceChildren(...keys.map((k) => {
    if (k === '|') return h('span', { class: 'sep', 'aria-hidden': 'true' });
    const [label, seq] = k;
    const attrs = { type: 'button', onmousedown: (ev) => ev.preventDefault() };   // keep the terminal focused (keyboard stays up)
    if (seq.startsWith('mod:')) {
      const m = seq.slice(4);
      attrs.class = 'mod';
      attrs.title = `${label}: tap for the next key, double-tap to lock`;
      attrs.onclick = () => {
        const now = Date.now();
        if (mods[m] === 1 && now - (lastTap[m] || 0) < 350) mods[m] = 2;
        else mods[m] = mods[m] ? 0 : 1;
        lastTap[m] = now;
        renderMods();
        open.get(state.active)?.term.focus();
      };
      const b = h('button', attrs, label);
      modBtns[m] = b;
      return b;
    }
    if (seq.startsWith('font:')) {
      attrs.onclick = () => setFontSize(termFontSize + Number(seq.slice(5)));
      attrs.title = 'Terminal font size (or pinch the terminal)';
      return h('button', attrs, label);
    }
    attrs.onclick = () => sendRawToActive(applyMods(seq));
    return h('button', attrs, label);
  }));
  const setOpen = (on) => {
    bar.classList.toggle('hidden', !on);
    btn.classList.toggle('active', on);
    try { localStorage.setItem('keybar', on ? '1' : '0'); } catch {}
    const cur = open.get(state.active);
    if (cur) requestAnimationFrame(() => { try { cur.fit.fit(); } catch {} });
  };
  let initial = false;
  try {
    const saved = localStorage.getItem('keybar');
    initial = saved !== null ? saved === '1' : window.matchMedia('(pointer: coarse)').matches;
  } catch {}
  if (initial) setOpen(true);
  btn.addEventListener('click', () => setOpen(bar.classList.contains('hidden')));
}

function attach(name, label) {
  closeMobileSheet();
  if (open.has(name)) return activate(name);
  const el = h('div', { class: 'term' });
  $('#terms').append(el);
  const term = new Terminal({
    cursorBlink: true, fontSize: termFontSize, scrollback: 5000, allowProposedApi: true,
    fontFamily: 'ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    theme: xtermTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit); term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(el);
  // Phone keyboards: no auto-capitalize / autocorrect / predictive junk in the terminal.
  if (term.textarea) {
    for (const [k, v] of [['autocapitalize', 'off'], ['autocorrect', 'off'], ['autocomplete', 'off'], ['spellcheck', 'false'], ['enterkeyhint', 'send']]) term.textarea.setAttribute(k, v);
  }
  attachTouch(term, el);
  // Let the browser handle paste/copy shortcuts instead of sending ^V / ^C to the program.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'v') return false;              // native paste event -> xterm -> pty
    if (k === 'c' && term.hasSelection() && (e.metaKey || (e.ctrlKey && e.shiftKey))) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    return true;
  });
  const dot = h('span', { class: 'dot', title: 'connecting' });
  const tab = h('button', { class: 'tab', onclick: () => activate(name) }, dot, h('span', {}, label),
    h('span', { class: 'x', title: 'Close tab (session keeps running)', onclick: (e) => { e.stopPropagation(); closeTab(name); } }, '×'));
  $('#tabs').append(tab);
  const entry = { term, fit, el, tab, dot, ws: null, closed: false, paused: false, bytes: 0, retries: 0, reconnTimer: null };
  el.addEventListener('mousedown', () => {
    if (splitMode && state.active !== name) {
      splitSecondary = state.active;
      state.active = name;
      renderTermLayout();
    }
  });
  open.set(name, entry);
  activate(name);
  connect(name, entry);
  term.onData((d) => entry.ws?.readyState === 1 && entry.ws.send(JSON.stringify({ t: 'i', d: applyMods(d) })));
  term.onResize(({ cols, rows }) => entry.ws?.readyState === 1 && entry.ws.send(JSON.stringify({ t: 'r', c: cols, r: rows })));
}

function connect(name, entry) {
  clearTimeout(entry.reconnTimer); entry.reconnTimer = null;
  entry.paused = false;
  try { entry.fit.fit(); } catch {}
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(name)}&cols=${entry.term.cols}&rows=${entry.term.rows}`);
  entry.ws = ws;
  const setDot = (cls, title) => { entry.dot.className = 'dot ' + cls; entry.dot.title = title; };
  ws.onopen = () => { entry.retries = 0; setDot('on', 'connected'); };
  ws.onmessage = (ev) => {
    const d = typeof ev.data === 'string' ? ev.data : '';
    entry.bytes += d.length;
    entry.term.write(d);
    setDot('on', `connected · ${entry.bytes} bytes received`);
  };
  ws.onerror = () => setDot('off', 'connection error');
  ws.onclose = (ev) => {
    setDot('off', `disconnected (code ${ev.code})`);
    if (entry.closed || entry.paused) return;
    const delay = Math.min(15000, 1500 * Math.pow(2, entry.retries));
    entry.retries = Math.min(entry.retries + 1, 5);
    entry.term.write('\r\n\x1b[33m[disconnected — reconnecting…]\x1b[0m\r\n');
    entry.reconnTimer = setTimeout(async () => {
      if (entry.closed || entry.paused) return;
      try { await loadSessions(); } catch { return; }
      if (entry.closed || entry.paused) return;
      if (sessions.some((s) => s.name === name)) connect(name, entry);
      else entry.term.write('\x1b[31m[session ended]\x1b[0m\r\n');
    }, delay);
  };
}

// Type text into the active terminal (bracketed paste when the program supports it).
function sendToActive(text, enter) {
  const e = open.get(state.active);
  if (!e) { showDialog('No terminal open', 'Open the session first, then paste.'); return false; }
  if (text) e.term.paste(text);
  if (enter) setTimeout(() => e.ws?.readyState === 1 && e.ws.send(JSON.stringify({ t: 'i', d: '\r' })), 50);
  e.term.focus();
  return true;
}
async function pasteDialog() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}   // only works on https/localhost
  if (!text) text = (await m3Prompt('Paste into terminal', 'Enter or paste text to send to the active terminal:', '', { okLabel: 'Send' })) || '';
  if (text) sendToActive(text, false);
}

let splitMode = false;
let splitSecondary = null;

function renderTermLayout() {
  const container = $('#terms');
  const validSec = splitMode && splitSecondary && open.has(splitSecondary) && splitSecondary !== state.active ? splitSecondary : null;
  if (splitMode && !validSec && open.size >= 2) {
    const other = [...open.keys()].find((k) => k !== state.active);
    if (other) splitSecondary = other;
  }
  const showSplit = splitMode && splitSecondary && open.has(splitSecondary) && splitSecondary !== state.active && !isMobile();
  container.classList.toggle('split', !!showSplit);
  $('#splitBtn')?.classList.toggle('active', splitMode);

  for (const [n, e] of open) {
    const isPrim = n === state.active;
    const isSec = showSplit && n === splitSecondary;
    e.el.classList.toggle('hidden', !isPrim && !isSec);
    e.el.classList.toggle('split-focused', showSplit && isPrim);
    e.el.classList.toggle('split-secondary', isSec);
    e.tab.classList.toggle('active', isPrim);
    e.tab.classList.toggle('split-peer', isSec);
  }
  $('#empty').classList.toggle('hidden', open.size > 0);
  requestAnimationFrame(() => {
    const p = open.get(state.active);
    const s = showSplit ? open.get(splitSecondary) : null;
    try { p?.fit.fit(); } catch {}
    try { s?.fit.fit(); } catch {}
    p?.term.focus();
  });
}

function toggleSplit() {
  if (open.size < 2 && !splitMode) {
    showDialog('Split view', 'Open at least 2 terminal sessions first to view them side-by-side.');
    return;
  }
  splitMode = !splitMode;
  if (splitMode && (!splitSecondary || splitSecondary === state.active || !open.has(splitSecondary))) {
    splitSecondary = [...open.keys()].find((k) => k !== state.active) || null;
  }
  renderTermLayout();
}

function setSplitPair(first, second) {
  state.active = first;
  splitSecondary = second;
  splitMode = !!(first && second && first !== second);
  renderTermLayout();
}

function activate(name) {
  if (splitMode && state.active && state.active !== name && open.has(state.active)) {
    splitSecondary = state.active;
  }
  state.active = name;
  renderTermLayout();
}

function closeTab(name) {
  const e = open.get(name); if (!e) return;
  clearTimeout(e.reconnTimer); e.reconnTimer = null;
  e.closed = true; e.ws?.close(); e.term.dispose(); e.el.remove(); e.tab.remove(); open.delete(name);
  if (splitSecondary === name) splitSecondary = null;
  if (state.active === name) {
    const next = [...open.keys()].pop();
    if (next) { state.active = next; } else { state.active = null; splitMode = false; }
  }
  if (open.size < 2) splitMode = false;
  renderTermLayout();
}

// Size the app to the *visible* viewport so the on-screen keyboard never covers the terminal.
let fitTimer = 0;
function refitSoon() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    const e = open.get(state.active); if (e) try { e.fit.fit(); } catch {}
    if (splitMode && splitSecondary) { const s = open.get(splitSecondary); if (s) try { s.fit.fit(); } catch {} }
  }, 60);
}
let vpWidth = 0, vpMaxH = 0;
function syncViewport() {
  const vv = window.visualViewport;
  const hgt = vv ? vv.height : window.innerHeight;
  const root = document.documentElement;
  root.style.setProperty('--app-h', `${Math.round(hgt)}px`);
  // Keyboard is up when the visible height drops well below the tallest we've seen at this width
  // (works whether the browser resizes the layout viewport or only the visual one).
  const w = Math.round(window.innerWidth);
  if (w !== vpWidth) { vpWidth = w; vpMaxH = 0; }
  vpMaxH = Math.max(vpMaxH, hgt, window.innerHeight);
  const kb = window.matchMedia('(pointer: coarse)').matches && vpMaxH - hgt > 150;
  root.classList.toggle('kb-open', kb);
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);   // iOS pans the page when the keyboard opens
  refitSoon();
}

// Start-up code (wires the UI). main.js calls this once every module has loaded.
function init() {
  try {
    const saved = Number(localStorage.getItem('termFontSize'));
    if (saved >= 10 && saved <= 22) termFontSize = saved;
  } catch {}
  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', () => setTimeout(syncViewport, 250));
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); });
  document.addEventListener('focusout', () => setTimeout(syncViewport, 120));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncViewport(); });
  syncViewport();
}

export { launch, termFontSize, setFontSize, initKeybar, attach, connect, sendToActive, pasteDialog, toggleSplit, setSplitPair, activate, closeTab, init };
