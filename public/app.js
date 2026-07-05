'use strict';

const $ = (sel) => document.querySelector(sel);
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Resolve API calls relative to the directory this page is served from, so the
// app works at the site root or under a subpath (e.g. /claude-manager/).
const BASE = location.pathname.replace(/[^/]*$/, '');

let claudeOnly = true;
let pickerCwd = null;
let runningNames = new Set();
let config = {};          // server capabilities (docker / autoclaude), loaded once
let sessionExists = true;  // whether the tmux session is currently running

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

// Clear a lingering (sticky) error once things recover, so a transient
// "Failed to fetch" doesn't stay on screen forever after the next poll succeeds.
function clearErrorBanner() {
  const el = $('#banner');
  if (el.classList.contains('error')) {
    el.classList.add('hidden');
    clearTimeout(bannerTimer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Server capabilities
// ---------------------------------------------------------------------------

async function loadConfig() {
  try {
    config = await api('api/config');
  } catch {
    config = {};
  }
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

  clearErrorBanner(); // fetch recovered
  $('#session-label').textContent = `session ${data.session}`;
  sessionExists = data.available;

  if (!data.available) {
    runningNames = new Set();
    $('#sessions').innerHTML =
      `<div class="empty">tmux session <b>${data.session}</b> is not running.<br>` +
      `<small>Tap <b>Resume</b> on a recent session below — tmux will start automatically.</small></div>`;
    return;
  }

  runningNames = new Set((data.windows || []).map((w) => w.name));

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
              ${w.sandbox ? '<span class="tag docker">docker</span>' : ''}
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
// History panel
// ---------------------------------------------------------------------------

async function loadHistory() {
  let data;
  try {
    data = await api('api/history');
  } catch {
    data = { entries: [] };
  }

  const entries = data.entries || [];
  if (!entries.length) {
    $('#history').innerHTML = '<div class="empty">No recent sessions yet.</div>';
    return;
  }

  $('#history').innerHTML = entries
    .map((e) => {
      const running = runningNames.has(e.name);
      const cls = ['session', 'h-session', running ? 'claude active' : ''].filter(Boolean).join(' ');
      const permLabel = e.permissionMode || 'auto';
      const sandboxTag = e.sandbox ? '<span class="tag docker">docker</span>' : '';
      return `
        <div class="${cls}">
          <span class="sw-status"></span>
          <div class="sw-main">
            <div class="sw-name">
              ${escapeHtml(e.name)}
              <span class="tag ${running ? 'claude' : ''}">${running ? 'running' : escapeHtml(permLabel)}</span>
              ${sandboxTag}
            </div>
            <div class="sw-cwd">${escapeHtml(e.dir)}</div>
          </div>
          <div class="h-meta">
            <span class="h-ago">${timeAgo(e.lastUsed)}</span>
            <button class="btn btn-resume"
              data-h-name="${escapeHtml(e.name)}"
              data-h-dir="${escapeHtml(e.dir)}"
              data-h-perm="${escapeHtml(permLabel)}"
              data-h-sandbox="${e.sandbox ? '1' : '0'}"
              data-h-kvm="${e.kvm ? '1' : '0'}"
            >${running ? 'Open again' : 'Resume'}</button>
          </div>
        </div>`;
    })
    .join('');
}

async function refresh() {
  await loadSessions();
  await loadHistory();
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
  $('#f-docker').checked = false;
  $('#f-kvm').checked = false;
  $('#name-hint').classList.remove('bad');
  setupDockerField();
  setupKvmField();
  setupAutoclaudeField();
  $('#f-name').focus();
}
function closeModal() { $('#modal').classList.add('hidden'); }

// Enable/disable the Docker sandbox toggle to match server capability, and show
// a build hint (with a "Build now" action) when the image isn't ready yet.
function setupDockerField() {
  const cb = $('#f-docker');
  const field = $('#docker-field');
  const hint = $('#docker-hint');
  if (!config.dockerAvailable) {
    cb.checked = false;
    cb.disabled = true;
    field.classList.add('disabled');
    hint.classList.remove('hidden');
    hint.textContent = 'Docker isn’t available on the server — install Docker to enable sandboxed sessions.';
    return;
  }
  cb.disabled = false;
  field.classList.remove('disabled');
  if (config.dockerImageReady) {
    hint.classList.add('hidden');
    hint.textContent = '';
  } else {
    hint.classList.remove('hidden');
    hint.innerHTML =
      'First sandbox session builds the image (~a few minutes). ' +
      '<button type="button" class="linklike" id="build-img-btn">Build now</button>';
  }
}

// The KVM toggle is only relevant for a sandbox session on a host that actually
// has /dev/kvm — show it only when Docker is both available and ticked.
function setupKvmField() {
  const field = $('#kvm-field');
  const show = config.dockerAvailable && config.kvmAvailable && $('#f-docker').checked;
  field.classList.toggle('hidden', !show);
  if (!show) $('#f-kvm').checked = false;
}

// The autoclaude prompt only makes sense when the binary exists AND the tmux
// session isn't running yet (a fresh session is about to be created).
function setupAutoclaudeField() {
  const field = $('#autoclaude-field');
  if (config.autoclaudeAvailable && !sessionExists) {
    field.classList.remove('hidden');
    $('#f-autoclaude').checked = true;
  } else {
    field.classList.add('hidden');
  }
}

async function buildImageNow(btn) {
  btn.disabled = true;
  btn.textContent = 'Building… (a few min)';
  try {
    await api('api/docker/build', { method: 'POST' });
    config.dockerImageReady = true;
    banner('Sandbox image built.', 'success');
    setupDockerField();
  } catch (err) {
    banner(`Build failed: ${err.message}`, 'error', true);
    btn.disabled = false;
    btn.textContent = 'Build now';
  }
}

async function submitNew(e) {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  const directory = $('#f-dir').value.trim();
  const permissionMode = $('#f-perm').value;
  const resume = $('#f-resume').checked;
  const sandbox = $('#f-docker').checked;
  const kvm = sandbox && $('#f-kvm').checked;
  const startAutoclaude =
    !$('#autoclaude-field').classList.contains('hidden') && $('#f-autoclaude').checked;

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
  btn.textContent = sandbox && !config.dockerImageReady ? 'Building image…' : 'Creating…';
  try {
    const r = await api('api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name, directory, resume, permissionMode, sandbox, kvm, startAutoclaude }),
    });
    if (sandbox) config.dockerImageReady = true;
    closeModal();
    let msg = `Started "${name}"${sandbox ? ' in a Docker sandbox' : ''}${kvm ? ' (KVM)' : ''} with remote control.`;
    if (r.autoclaudeStarted) msg += ' autoclaude started.';
    banner(msg, 'success');
    await refresh();
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
  $('#refresh-btn').addEventListener('click', refresh);
  $('#new-form').addEventListener('submit', submitNew);
  $('#claude-only').addEventListener('change', (e) => { claudeOnly = e.target.checked; refresh(); });

  // "Build now" inside the Docker hint (delegated — the button is re-rendered).
  $('#docker-hint').addEventListener('click', (e) => {
    const b = e.target.closest('#build-img-btn');
    if (b) buildImageNow(b);
  });
  // Toggling the sandbox checkbox shows/hides the dependent KVM option.
  $('#f-docker').addEventListener('change', setupKvmField);

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
      await refresh();
    } catch (err) {
      banner(`Failed to kill: ${err.message}`, 'error');
      btn.disabled = false;
    }
  });

  // Resume from history (event-delegated)
  $('#history').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-h-name]');
    if (!btn) return;
    const name = btn.dataset.hName;
    const directory = btn.dataset.hDir;
    const permissionMode = btn.dataset.hPerm || 'auto';
    const sandbox = btn.dataset.hSandbox === '1';
    const kvm = btn.dataset.hKvm === '1';
    // Offer autoclaude only when it exists and the session must be created fresh.
    let startAutoclaude = false;
    if (config.autoclaudeAvailable && !sessionExists) {
      startAutoclaude = confirm('The tmux session isn’t running yet — also start autoclaude in it?');
    }
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const r = await api('api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name, directory, resume: true, permissionMode, sandbox, kvm, startAutoclaude }),
      });
      let msg = `Resumed "${name}"${sandbox ? ' (Docker sandbox)' : ''}${kvm ? ' (KVM)' : ''}.`;
      if (r.autoclaudeStarted) msg += ' autoclaude started.';
      banner(msg, 'success');
      await refresh();
    } catch (err) {
      banner(`Failed to resume: ${err.message}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Resume';
    }
  });

  // Capabilities change rarely (installing docker/autoclaude, building the
  // image) so load once at start; submitNew/buildImageNow patch the cached copy
  // when they change it.
  loadConfig().then(refresh);
  setInterval(refresh, 5000);
}

document.addEventListener('DOMContentLoaded', init);
