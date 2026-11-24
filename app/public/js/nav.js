// Navigation rail, side panel collapse and the mobile drawer.
import { state } from './state.js';
import { $ } from './core.js';
import { open } from './workspace.js';

const PANE_TITLES = {
  workspace: 'Workspace',
  sessions: 'Sessions',
  ollama: 'Local Models',
  automations: 'Automations',
  github: 'GitHub',
  system: 'System',
};
let activePane = 'workspace';
const isMobile = () => window.matchMedia && window.matchMedia('(max-width: 860px)').matches;
function openMobileSheet() { $('#sidebar').classList.add('open'); $('#sideScrim')?.classList.add('open'); }
function closeMobileSheet() { $('#sidebar').classList.remove('open'); $('#sideScrim')?.classList.remove('open'); }
function refitActive() {
  const cur = open.get(state.active);
  if (cur) setTimeout(() => { try { cur.fit.fit(); } catch {} }, 360);
}
function setPaneCollapsed(collapsed) {
  $('#app').classList.toggle('pane-collapsed', collapsed);
  try { localStorage.setItem('paneCollapsed', collapsed ? '1' : '0'); } catch {}
  refitActive();
}
function selectPane(pane, fromUser) {
  if (!PANE_TITLES[pane]) pane = 'workspace';
  const same = pane === activePane;
  activePane = pane;
  try { localStorage.setItem('activePane', pane); } catch {}
  $('#paneSubtitle').textContent = PANE_TITLES[pane];
  for (const b of document.querySelectorAll('#navRail .rail-btn')) b.classList.toggle('active', b.dataset.pane === pane);
  for (const p of document.querySelectorAll('#sidebar .pane')) p.classList.toggle('active', p.dataset.pane === pane);
  if (fromUser) {
    if (isMobile()) {
      if (same && $('#sidebar').classList.contains('open')) closeMobileSheet();
      else openMobileSheet();
    } else {
      const collapsed = $('#app').classList.contains('pane-collapsed');
      if (same) setPaneCollapsed(!collapsed);
      else if (collapsed) setPaneCollapsed(false);
    }
  }
}
function initNavRail() {
  for (const b of document.querySelectorAll('#navRail .rail-btn')) {
    b.addEventListener('click', () => selectPane(b.dataset.pane, true));
  }
  $('#collapseSide')?.addEventListener('click', () => setPaneCollapsed(true));
  $('#railToggle')?.addEventListener('click', () => setPaneCollapsed(!$('#app').classList.contains('pane-collapsed')));
  try {
    const savedPane = localStorage.getItem('activePane');
    if (savedPane && PANE_TITLES[savedPane]) selectPane(savedPane, false);
    if (!isMobile() && localStorage.getItem('paneCollapsed') === '1') $('#app').classList.add('pane-collapsed');
  } catch {}
  const mb = $('#modelsBox');
  if (mb) {
    try { if (localStorage.getItem('modelsBox') === 'closed') mb.open = false; } catch {}
    mb.addEventListener('toggle', () => { try { localStorage.setItem('modelsBox', mb.open ? 'open' : 'closed'); } catch {} });
  }
}

// Start-up code (wires the UI). main.js calls this once every module has loaded.
function init() {
  // Swipe the drawer left to close it.
  (function initSheetSwipe() {
    const side = $('#sidebar');
    let x0 = 0, y0 = 0, dx = 0, tracking = false, horiz = null;
    side.addEventListener('touchstart', (ev) => {
      if (!isMobile() || !side.classList.contains('open') || ev.touches.length !== 1) return;
      if (ev.target.closest('input, textarea, select, .tab-list, .models-box .list')) return;
      x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dx = 0; tracking = true; horiz = null;
    }, { passive: true });
    side.addEventListener('touchmove', (ev) => {
      if (!tracking) return;
      const mx = ev.touches[0].clientX - x0, my = ev.touches[0].clientY - y0;
      if (horiz === null && Math.hypot(mx, my) > 10) horiz = Math.abs(mx) > Math.abs(my) * 1.3 && mx < 0;
      if (!horiz) { if (horiz === false) tracking = false; return; }
      dx = Math.min(0, mx);
      side.classList.add('dragging');
      side.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    const end = () => {
      if (!tracking) return;
      tracking = false;
      side.classList.remove('dragging');
      side.style.transform = '';
      if (horiz && dx < -Math.min(110, side.offsetWidth * 0.3)) closeMobileSheet();
    };
    side.addEventListener('touchend', end);
    side.addEventListener('touchcancel', end);
  })();
}

export { isMobile, openMobileSheet, closeMobileSheet, initNavRail, init };
