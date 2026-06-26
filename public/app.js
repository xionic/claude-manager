'use strict';

const $ = (sel) => document.querySelector(sel);
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Resolve API calls relative to the directory this page is served from, so the
// app works at the site root or under a subpath (e.g. /claude-manager/).
const BASE = location.pathname.replace(/[^/]*$/, '');

let claudeOnly = true;
let pickerCwd = null;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  // `path` is given without a leading slash (e.g. "api/sessions").
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

let bannerTimer = null;
function banner(msg, kind = 'success', sticky = false) {
  const el = $('#banner');
  el.textContent = msg;
  el.className = `banner ${kind}`;
  clearTimeout(bannerTimer);
  if (!sticky) bannerTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

async function loadSessions() {
  let data;
  try {
    data = await api('api/sessions');
  } catch (err) {
    banner(`Could not load sessions: ${err.message}`, 'error', true);
    return;
  }

  $('#session-label').textContent = `session ${data.session}`;

  if (!data.available) {
    $('#sessions').innerHTML =
      `<div class="empty">tmux session <b>${data.session}</b> is not running.<br><small>${escapeHtml(data.error || '')}</small></div>`;
    return;
  }

  let windows = data.windows;
  if (claudeOnly) windows = windows.filter((w) => w.isClaude);

  if (!windows.length) {
    $('#sessions').innerHTML = `<div class="empty">No ${claudeOnly ? 'Claude ' : ''}windows yet. Start one with <b>+ New session</b>.</div>`;
    return;
  }

  $('#sessions').innerHTML = windows
    .map((w) => {
      const cls = ['session'];
      if (w.isClaude) cls.push('claude');
      if (w.active) cls.push('active');
      const title = w.title && w.title !== w.name ? escapeHtml(w.title) : '';
      return `
        <div class="${cls.join(' ')}">
          <span class="sw-status"></span>
          <div class="sw-main">
            <div class="sw-name">
              <span class="idx">${w.index}</span>
              ${escapeHtml(w.name)}
              ${w.isClaude ? '<span class="tag claude">claude</span>' : `<span class="tag">${escapeHtml(w.command)}</span>`}
            </div>
            ${title ? `<div class="sw-title">${title}</div>` : ''}
            <div class="sw-cwd">${escapeHtml(w.cwd)}</div>
          </div>
          <button class="btn btn-danger" data-kill="${w.id}" data-name="${escapeHtml(w.name)}">Kill</button>
        </div>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------------------------------------------------------------------------
// New session modal
// ---------------------------------------------------------------------------

function openModal() {
  $('#modal').classList.remove('hidden');
  $('#f-name').value = '';
  $('#f-dir').value = '';
  $('#f-perm').value = 'auto';
  $('#f-resume').checked = false;
  $('#name-hint').classList.remove('bad');
  $('#f-name').focus();
}
function closeModal() { $('#modal').classList.add('hidden'); }

async function submitNew(e) {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  const directory = $('#f-dir').value.trim();
  const permissionMode = $('#f-perm').value;
  const resume = $('#f-resume').checked;

  if (!NAME_RE.test(name)) {
    $('#name-hint').classList.add('bad');
    $('#name-hint').textContent = 'Invalid: use 1-64 chars — letters, numbers, dot, dash, underscore.';
    return;
  }
  if (!directory) {
    banner('Pick a directory first.', 'warn');
    return;
  }

  const btn = $('#create-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    await api('api/sessions', { method: 'POST', body: JSON.stringify({ name, directory, resume, permissionMode }) });
    closeModal();
    banner(`Started "${name}" with remote control.`, 'success');
    await loadSessions();
  } catch (err) {
    banner(`Failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create session';
  }
}

// ---------------------------------------------------------------------------
// Directory picker
// ---------------------------------------------------------------------------

async function openPicker(startPath) {
  $('#picker').classList.remove('hidden');
  $('#newdir-name').value = '';
  await loadPicker(startPath);
}
function closePicker() { $('#picker').classList.add('hidden'); }

async function loadPicker(p) {
  let data;
  try {
    data = await api(`api/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`);
  } catch (err) {
    banner(`Browse failed: ${err.message}`, 'error');
    return;
  }
  pickerCwd = data.cwd;
  $('#picker-path').textContent = data.cwd;

  $('#picker-roots').innerHTML = data.roots
    .map((r) => `<span class="root-chip" data-root="${escapeHtml(r)}">${escapeHtml(r)}</span>`)
    .join('');

  const rows = [];
  if (data.parent) {
    rows.push(`<div class="picker-item up" data-go="${escapeHtml(data.parent)}"><span class="ico">↑</span> ..</div>`);
  }
  for (const e of data.entries) {
    rows.push(`<div class="picker-item" data-go="${escapeHtml(e.path)}"><span class="ico">▸</span> ${escapeHtml(e.name)}</div>`);
  }
  $('#picker-list').innerHTML = rows.join('') || '<div class="empty">No subdirectories.</div>';
}

async function createDir() {
  const name = $('#newdir-name').value.trim();
  if (!name) { banner('Enter a folder name first.', 'warn'); return; }
  if (!pickerCwd) { banner('Open a directory first.', 'warn'); return; }

  const btn = $('#newdir-btn');
  btn.disabled = true;
  try {
    const data = await api('api/mkdir', {
      method: 'POST',
      body: JSON.stringify({ parent: pickerCwd, name }),
    });
    $('#newdir-name').value = '';
    banner(`Created "${name}".`, 'success');
    await loadPicker(data.path); // navigate into the new folder
  } catch (err) {
    banner(`Couldn't create folder: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  $('#new-btn').addEventListener('click', openModal);
  $('#refresh-btn').addEventListener('click', loadSessions);
  $('#new-form').addEventListener('submit', submitNew);
  $('#claude-only').addEventListener('change', (e) => { claudeOnly = e.target.checked; loadSessions(); });

  // Close handlers
  document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  document.querySelectorAll('[data-close-picker]').forEach((el) => el.addEventListener('click', closePicker));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closePicker(); }
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') closePicker(); });

  // Picker open / navigate / select
  $('#pick-btn').addEventListener('click', () => openPicker($('#f-dir').value.trim() || null));
  $('#picker-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-go]');
    if (item) loadPicker(item.dataset.go);
  });
  $('#picker-roots').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-root]');
    if (chip) loadPicker(chip.dataset.root);
  });
  $('#picker-select').addEventListener('click', () => {
    if (pickerCwd) { $('#f-dir').value = pickerCwd; closePicker(); }
  });

  // Create folder in the current picker directory
  $('#newdir-btn').addEventListener('click', createDir);
  $('#newdir-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createDir(); }
  });

  // Kill (event-delegated)
  $('#sessions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-kill]');
    if (!btn) return;
    if (!confirm(`Kill window "${btn.dataset.name}"? The Claude process in it will stop.`)) return;
    btn.disabled = true;
    try {
      await api(`api/sessions/${encodeURIComponent(btn.dataset.kill)}/kill`, { method: 'POST' });
      banner(`Killed "${btn.dataset.name}".`, 'success');
      await loadSessions();
    } catch (err) {
      banner(`Failed to kill: ${err.message}`, 'error');
      btn.disabled = false;
    }
  });

  loadSessions();
  setInterval(loadSessions, 5000);
}

document.addEventListener('DOMContentLoaded', init);
