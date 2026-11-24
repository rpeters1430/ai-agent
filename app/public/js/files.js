// Repository file and image browser.
import { $, api, h } from './core.js';
import { closeMobileSheet } from './nav.js';

let filesCtx = { repo: '', wt: '', dir: '', currentFile: '' };

async function loadFilesDir(dir) {
  filesCtx.dir = dir;
  const { repo, wt } = filesCtx;
  $('#filesTitle').textContent = `Files · ${repo}${wt ? ` / ${wt}` : ''}`;
  const qs = new URLSearchParams({ ...(wt ? { wt } : {}), ...(dir ? { dir } : {}) });
  const d = await api('GET', `/api/repos/${encodeURIComponent(repo)}/files?${qs}`);

  const crumbs = $('#filesBreadcrumbs');
  crumbs.replaceChildren();
  const parts = dir ? dir.split('/').filter(Boolean) : [];
  crumbs.append(h('button', { class: 'link', onclick: () => loadFilesDir('') }, repo));
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    const target = acc;
    crumbs.append(' / ', h('button', { class: 'link', onclick: () => loadFilesDir(target) }, p));
  }

  const list = $('#filesList');
  list.replaceChildren();
  if (parts.length) {
    const parent = parts.slice(0, -1).join('/');
    list.append(h('div', { class: 'item clickable', onclick: () => loadFilesDir(parent) },
      h('div', { class: 'top' }, h('span', { class: 'name' }, '📁 ..'))));
  }
  if (!d.entries.length) list.append(h('p', { class: 'small muted' }, 'Empty directory.'));
  for (const e of d.entries) {
    list.append(h('div', { class: 'item clickable', onclick: () => (e.dir ? loadFilesDir(e.path) : openFilePreview(e.path)) },
      h('div', { class: 'top' },
        h('span', { class: 'name' }, `${e.dir ? '📁' : e.isImage ? '🖼' : '📄'} ${e.name}`),
        h('span', { class: 'spacer' }),
        !e.dir && h('span', { class: 'meta' }, e.size >= 1024 ? `${Math.round(e.size / 1024)} KB` : `${e.size} B`))));
  }
}

async function openFilePreview(relPath) {
  const { repo, wt } = filesCtx;
  filesCtx.currentFile = relPath;
  const qs = new URLSearchParams({ ...(wt ? { wt } : {}), path: relPath });
  const d = await api('GET', `/api/repos/${encodeURIComponent(repo)}/file?${qs}`);
  $('#filePreviewBox').classList.remove('hidden');
  $('#filePreviewName').textContent = relPath;
  const img = $('#filePreviewImg');
  const code = $('#filePreviewCode');
  if (d.isImage) {
    img.src = d.rawUrl;
    img.classList.remove('hidden');
    code.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    code.classList.remove('hidden');
    code.textContent = d.isBinary ? '(binary file — cannot preview as text)' : (d.content + (d.truncated ? '\n…(truncated at 300 KB)' : ''));
  }
}

async function openFileBrowser(repo, wt = '') {
  filesCtx = { repo, wt, dir: '', currentFile: '' };
  $('#filePreviewBox').classList.add('hidden');
  closeMobileSheet();
  $('#filesDlg').showModal();
  try { await loadFilesDir(''); } catch (e) { $('#filesList').replaceChildren(h('p', { class: 'err small' }, e.message)); }
}

export { filesCtx, openFileBrowser };
