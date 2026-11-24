// Diff viewer with commit / branch / stash / discard actions.
import { $, api, busy, h, m3Confirm } from './core.js';
import { loadLocal } from './workspace.js';
import { closeMobileSheet } from './nav.js';

let diffCtx = { repo: '', wt: '' };

function renderUnifiedDiff(text) {
  const box = $('#diffPatch');
  box.replaceChildren();
  if (!text || !text.trim()) {
    box.append(h('div', { class: 'small muted', style: 'padding:12px' }, 'No tracked diff (working tree matches HEAD).'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) {
    let cls = 'diff-line';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) cls += ' diff-meta';
    else if (line.startsWith('@@')) cls += ' diff-hunk';
    else if (line.startsWith('+')) cls += ' diff-add';
    else if (line.startsWith('-')) cls += ' diff-del';
    frag.append(h('div', { class: cls }, line || ' '));
  }
  box.append(frag);
}

async function refreshDiffViewer() {
  const { repo, wt } = diffCtx;
  const qs = wt ? `?wt=${encodeURIComponent(wt)}` : '';
  const d = await api('GET', `/api/repos/${encodeURIComponent(repo)}/diff${qs}`);
  $('#diffTitle').textContent = `Diff · ${repo}${wt ? ` / ${wt}` : ''}`;

  const brSel = $('#diffBranchSel');
  brSel.replaceChildren(...(d.branches.length ? d.branches : [d.branch]).map((b) => h('option', { value: b }, b)));
  brSel.value = d.branch;

  const fbox = $('#diffFiles');
  fbox.replaceChildren();
  if (!d.files.length) {
    fbox.append(h('p', { class: 'small muted', style: 'margin:0' }, 'Working tree is clean.'));
  } else {
    for (const f of d.files) {
      fbox.append(h('div', { class: 'item' },
        h('div', { class: 'top' },
          h('span', { class: 'badge ' + (f.untracked ? 'warn' : 'live') }, f.code.trim() || 'M'),
          h('span', { class: 'name', title: f.path, style: 'font-family:var(--mono);font-size:12px' }, f.path),
          h('span', { class: 'spacer' }),
          h('button', { style: 'font-size:11px;padding:2px 8px', onclick: (e) => busy(e.target, async () => {
            if (!(await m3Confirm('Discard changes?', `Revert "${f.path}"? Uncommitted edits to this file will be lost.`, { okLabel: 'Discard', danger: true }))) return;
            await api('POST', `/api/repos/${encodeURIComponent(repo)}/git/action`, { wt: wt || undefined, action: 'discard', file: f.path });
            await refreshDiffViewer(); loadLocal();
          }) }, 'Discard'))));
    }
  }
  renderUnifiedDiff(d.diff);
}

async function openDiffViewer(repo, wt = '') {
  diffCtx = { repo, wt };
  closeMobileSheet();
  $('#diffDlg').showModal();
  $('#diffFiles').replaceChildren(h('p', { class: 'small muted' }, 'Loading diff…'));
  $('#diffPatch').replaceChildren();
  try { await refreshDiffViewer(); } catch (e) { $('#diffFiles').replaceChildren(h('p', { class: 'err small' }, e.message)); }
}

export { diffCtx, refreshDiffViewer, openDiffViewer };
