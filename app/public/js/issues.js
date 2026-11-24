// GitHub issues / PRs browser with "send to agent".
import { $, api, busy, h } from './core.js';
import { status } from './workspace.js';
import { closeMobileSheet } from './nav.js';
import { autoState, loadAuto } from './automations.js';
import { showNoticeToast } from './upload.js';

async function openRepoIssues(fullName) {
  const [owner, name] = fullName.split('/');
  $('#issuesTitle').textContent = `Issues & PRs · ${fullName}`;
  const sel = $('#issuesAgentSel');
  const installed = Object.entries(status.agents || {}).filter(([k, a]) => k !== 'shell' && a.installed);
  sel.replaceChildren(...installed.map(([k, a]) => h('option', { value: k }, a.label)));
  if (typeof autoState !== 'undefined' && autoState.watch?.agent) sel.value = autoState.watch.agent;
  const list = $('#issuesList');
  list.replaceChildren(h('p', { class: 'small muted' }, 'Loading open issues & PRs…'));
  closeMobileSheet();
  $('#issuesDlg').showModal();
  try {
    const d = await api('GET', `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/items`);
    list.replaceChildren();
    if (!d.items.length) { list.append(h('p', { class: 'small muted' }, 'No open issues or pull requests.')); return; }
    for (const it of d.items) {
      list.append(h('div', { class: 'item' },
        h('div', { class: 'top' },
          h('span', { class: 'badge ' + (it.isPr ? 'size' : 'live') }, it.isPr ? (it.draft ? 'PR draft' : 'PR') : 'Issue'),
          h('a', { class: 'name', href: it.url, target: '_blank', rel: 'noopener noreferrer', style: 'color:inherit' }, `#${it.number} ${it.title}`)),
        h('div', { class: 'top badges' },
          h('span', { class: 'meta' }, `@${it.author} · ${it.comments} comments`),
          ...it.labels.map((l) => h('span', { class: 'badge' }, l.name))),
        h('div', { class: 'actions' },
          h('button', { class: 'agent', onclick: (e) => busy(e.target, async () => {
            await api('POST', `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/dispatch`, {
              number: it.number, action: 'fix_issue', title: it.title, agent: sel.value,
            });
            showNoticeToast('Automation queued', `${it.isPr ? 'Working on PR' : 'Fixing issue'} #${it.number} in ${fullName}`);
            if (typeof loadAuto === 'function') loadAuto();
          }) }, it.isPr ? 'Work on PR' : 'Fix issue'),
          it.isPr && h('button', { onclick: (e) => busy(e.target, async () => {
            await api('POST', `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/dispatch`, {
              number: it.number, action: 'review', title: it.title, agent: sel.value,
            });
            showNoticeToast('Review queued', `Reviewing PR #${it.number} in ${fullName}`);
            if (typeof loadAuto === 'function') loadAuto();
          }) }, 'Review PR'))));
    }
  } catch (e) {
    list.replaceChildren(h('p', { class: 'err small' }, e.message));
  }
}

export { openRepoIssues };
