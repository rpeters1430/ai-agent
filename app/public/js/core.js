// DOM + API helpers (h, $, api, busy) and the Material 3 dialogs (showDialog, m3Confirm, m3Prompt).
import { showLogin } from './auth.js';

const $ = (s) => document.querySelector(s);

// Tiny DOM builder (all text via textContent - no HTML injection).
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
function showDialog(title, body) { $('#dlgTitle').textContent = title; $('#dlgBody').textContent = body; $('#dlg').showModal(); }
async function busy(btn, fn) { btn.disabled = true; try { return await fn(); } catch (e) { if (e.message !== 'unauthorized') showDialog('Error', e.message); } finally { btn.disabled = false; } }

// Reusable Material 3 Expressive confirm & prompt modal (replaces native browser popups).
function m3Modal({ title, message = '', input = false, defaultValue = '', placeholder = '', okLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#m3Modal');
    const form = $('#m3ModalForm');
    const inp = $('#m3ModalInput');
    const okBtn = $('#m3ModalOk');
    const cancelBtn = $('#m3ModalCancel');
    $('#m3ModalTitle').textContent = title;
    $('#m3ModalMsg').textContent = message;
    $('#m3ModalMsg').classList.toggle('hidden', !message);
    inp.classList.toggle('hidden', !input);
    inp.value = defaultValue;
    inp.placeholder = placeholder;
    okBtn.textContent = okLabel;
    okBtn.className = danger ? 'danger' : 'primary';

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onSubmit = (e) => { e.preventDefault(); finish(input ? inp.value : true); };
    const onCancel = (e) => { if (e) e.preventDefault(); finish(input ? null : false); };

    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    if (input) { inp.focus(); inp.select(); } else okBtn.focus();
  });
}
const m3Confirm = (title, message, opts = {}) => m3Modal({ title, message, input: false, okLabel: 'Confirm', ...opts });
const m3Prompt = (title, message, defaultValue = '', opts = {}) => m3Modal({ title, message, input: true, defaultValue, okLabel: 'OK', ...opts });

function setRailBadge(selector, count) {
  const el = $(selector);
  if (!el) return;
  const n = Number(count) || 0;
  el.textContent = n > 99 ? '99+' : String(n);
  el.classList.toggle('hidden', n <= 0);
}

export { $, h, api, showDialog, busy, m3Confirm, m3Prompt, setRailBadge };
