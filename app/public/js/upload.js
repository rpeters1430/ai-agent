// Image/file upload into the container (drag & drop, paste) and notice toasts.
import { state } from './state.js';
import { $, api, h, showDialog } from './core.js';
import { open } from './workspace.js';
import { sendToActive } from './terminals.js';

function showNoticeToast(title, body, imgUrl) {
  const toast = h('div', { class: 'toast' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('b', {}, title),
      h('button', { class: 'icon', title: 'Dismiss', onclick: () => toast.remove() }, '✕')),
    body && h('div', { class: 'small muted', style: 'word-break:break-all' }, body),
    imgUrl && h('img', { src: imgUrl, class: 'toast-thumb', alt: '' }));
  $('#toasts').append(toast);
  setTimeout(() => toast.remove(), 7000);
}

async function uploadAndPasteFile(file) {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    showDialog('File too large', 'Uploads are limited to 15 MB.');
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
  const res = await api('POST', '/api/upload', { filename: file.name || 'paste.png', data: dataUrl });
  const isImg = /^image\//.test(file.type || '');
  if (state.active && open.has(state.active)) {
    sendToActive(res.path + ' ', false);
    showNoticeToast('Uploaded & pasted path', res.path, isImg ? res.url : null);
  } else {
    showNoticeToast('Uploaded to container', res.path, isImg ? res.url : null);
  }
}

export { showNoticeToast, uploadAndPasteFile };
