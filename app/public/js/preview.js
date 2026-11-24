// Dev-server port preview (separate preview origin).
import { $, api, h, showDialog } from './core.js';

async function refreshPreviewPorts() {
  const box = $('#previewPorts');
  box.replaceChildren(h('span', { class: 'small muted' }, 'Scanning listening ports…'));
  try {
    const hData = await api('GET', '/api/system/health');
    box.replaceChildren();
    if (!hData.ports?.length) {
      box.append(h('span', { class: 'small muted' }, 'No dev servers detected yet. Start a server (e.g. npm run dev or dsh web) and click Scan ports, or enter a port below.'));
      return;
    }
    for (const port of hData.ports) {
      box.append(h('button', { class: 'tonal', onclick: () => openPortPreview(port, false) }, `:${port} (inline)`),
        h('button', { onclick: () => openPortPreview(port, true) }, `:${port} ↗`));
    }
  } catch (e) {
    box.replaceChildren(h('span', { class: 'err small' }, e.message));
  }
}

async function openPortPreview(port, newTab) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    showDialog('Invalid port', 'Enter a port between 1024 and 65535.');
    return;
  }
  // Previews are served from a separate port (their own origin) with a short-lived sign-in link.
  let url;
  try { url = (await api('GET', `/api/preview/link?port=${p}`)).url; } catch (e) {
    if (e.message !== 'unauthorized') showDialog('Preview', e.message);
    return;
  }
  // An https page can't show an http preview inline (mixed content), so open it in a tab instead.
  if (newTab || (location.protocol === 'https:' && url.startsWith('http:'))) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const shown = url.replace(/[?&]ah_pt=[^&#]*/, '');
  $('#previewPortInput').value = String(p);
  $('#previewFrameUrl').textContent = `Proxying container localhost:${p} → ${shown}`;
  $('#previewFrameExt').href = shown;
  $('#previewFrameExt').onclick = (e) => { e.preventDefault(); openPortPreview(p, true); }; // fresh sign-in link
  $('#previewFrame').src = url;
  $('#previewFrameWrap').classList.remove('hidden');
}

export { refreshPreviewPorts, openPortPreview };
