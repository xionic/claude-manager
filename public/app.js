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
let lastHistory = [];      // most-recent history entries (for restart params)
let lastSessionsData = null; // last /api/sessions response (for re-render on search)
let searchQuery = '';      // lowercased name filter for both panels

const matchesSearch = (name) => !searchQuery || String(name).toLowerCase().includes(searchQuery);

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
  lastSessionsData = data;
  $('#session-label').textContent = `session ${data.session}`;
  sessionExists = data.available;
  runningNames = new Set(data.available ? (data.windows || []).map((w) => w.name) : []);
  renderRunning();
}

// Render the running-windows panel from the last fetch, applying the Claude-only
// toggle and the name search. Split from loadSessions so search re-renders
// without refetching (which would re-run ss/tmux each keystroke).
function renderRunning() {
  const data = lastSessionsData;
  if (!data) return;

  if (!data.available) {
    $('#sessions').innerHTML =
      `<div class="empty">tmux session <b>${escapeHtml(data.session)}</b> is not running.<br>` +
      `<small>Tap <b>Resume</b> on a recent session below — tmux will start automatically.</small></div>`;
    return;
  }

  let windows = data.windows || [];
  if (claudeOnly) windows = windows.filter((w) => w.isClaude);
  if (searchQuery) windows = windows.filter((w) => matchesSearch(w.name));

  if (!windows.length) {
    const msg = searchQuery
      ? 'No running sessions match your search.'
      : `No ${claudeOnly ? 'Claude ' : ''}windows yet. Start one with <b>+ New session</b>.`;
    $('#sessions').innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  $('#sessions').innerHTML = windows
    .map((w) => {
      const cls = ['session', 'clickable'];
      if (w.isClaude) cls.push('claude');
      if (w.active) cls.push('active');
      const disconnected = w.remoteConnected === false;
      if (disconnected) cls.push('disconnected');
      const title = w.title && w.title !== w.name ? escapeHtml(w.title) : '';
      const dcTag = disconnected
        ? '<span class="tag warn" title="Process is alive but its remote-control connection to Anthropic has dropped — not visible in the Claude app. Restart to re-register.">disconnected</span>'
        : '';
      // Restart (kill + resume) is available on every running session — it also
      // covers docker/sandbox windows and cases where connectivity is unknown.
      const restartBtn =
        `<button class="btn${disconnected ? ' btn-restart-hi' : ''}" data-restart="${w.id}" data-rc-name="${escapeHtml(w.name)}" data-rc-cwd="${escapeHtml(w.cwd)}" data-rc-sandbox="${w.sandbox ? '1' : '0'}">Restart</button>`;
      return `
        <div class="${cls.join(' ')}" data-win="${escapeHtml(w.id)}" data-win-name="${escapeHtml(w.name)}" title="Click for the tmux attach command">
          <span class="sw-status"></span>
          <div class="sw-main">
            <div class="sw-name">
              <span class="idx">${w.index}</span>
              ${escapeHtml(w.name)}
              ${w.isClaude ? '<span class="tag claude">claude</span>' : `<span class="tag">${escapeHtml(w.command)}</span>`}
              ${w.sandbox ? '<span class="tag docker">docker</span>' : ''}
              ${memTag(w)}
              ${dcTag}
            </div>
            ${title ? `<div class="sw-title">${title}</div>` : ''}
            <div class="sw-cwd">${escapeHtml(w.cwd)}</div>
          </div>
          <div class="sw-actions">
            <button class="btn btn-danger" data-kill="${w.id}" data-name="${escapeHtml(w.name)}">Kill</button>
            ${restartBtn}
          </div>
        </div>`;
    })
    .join('');
}

// Human-readable memory size from bytes (e.g. 512 MB, 3.4 GB).
function formatBytes(n) {
  if (n == null || !isFinite(n)) return null;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

// Per-session memory badge. Turns amber past 4 GB and red past 8 GB so a
// runaway session stands out before it can thrash the box. Sandbox sessions
// report the pane's cgroup only (the container's memory lives elsewhere), so
// their number undercounts — flag that in the tooltip rather than mislead.
function memTag(w) {
  const label = formatBytes(w.memoryBytes);
  if (!label) return '';
  const gb = w.memoryBytes / 1024 ** 3;
  const cls = gb >= 8 ? ' danger' : gb >= 4 ? ' warn' : '';
  const tip = w.sandbox
    ? 'Host pane memory only — the sandbox container is not counted'
    : 'Resident memory of this session and all its child processes';
  return `<span class="tag mem${cls}" title="${tip}">${label}</span>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------------------------------------------------------------------------
// Attach-command popup — how to reach a running window from a real terminal
// ---------------------------------------------------------------------------

// Build the tmux commands for a window id (e.g. "@11"). `socketArg` is empty for
// the default socket, or "-S <path>" when the server uses a custom one. The `\;`
// is the literal escape a shell needs so tmux gets `select-window` as a second
// command; window ids are globally unique so `-t @11` is unambiguous.
function attachCommands(windowId) {
  const sock = config.socketArg ? `${config.socketArg} ` : '';
  const sess = config.session ?? '0';
  return {
    full: `tmux ${sock}attach -t ${sess} \\; select-window -t ${windowId}`,
    inside: `tmux ${sock}select-window -t ${windowId}`,
  };
}

// Restart a session: kill the window (tearing down its container if it's a
// sandbox) and re-launch it with resume, so a fresh claude re-registers remote
// control on the same conversation. Works for host, docker, and unknown-state
// windows alike. Params come from history (original launch dir + permission/
// sandbox/kvm); we fall back to the window's own name/cwd if it isn't in history.
async function restartSession(btn) {
  const name = btn.dataset.rcName;
  const entry = lastHistory.find((e) => e.name === name);
  const directory = entry?.dir || btn.dataset.rcCwd;
  const permissionMode = entry?.permissionMode || 'auto';
  const sandbox = entry ? !!entry.sandbox : btn.dataset.rcSandbox === '1';
  const kvm = entry ? !!entry.kvm : false;
  const windowId = btn.dataset.restart;

  if (!confirm(`Restart "${name}"? Its current process stops and a fresh one resumes the same conversation.`)) return;

  btn.disabled = true;
  btn.textContent = 'Restarting…';
  try {
    await api(`api/sessions/${encodeURIComponent(windowId)}/kill`, { method: 'POST' });
    await api('api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name, directory, resume: true, permissionMode, sandbox, kvm }),
    });
    banner(`Restarted “${name}”.`, 'success');
    await refresh();
  } catch (err) {
    banner(`Restart failed: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Restart';
  }
}

function openAttachModal(windowId, name) {
  const { full, inside } = attachCommands(windowId);
  $('#attach-title').textContent = `Attach to “${name}”`;
  $('#attach-cmd').textContent = full;
  $('#attach-cmd-alt').textContent = inside;
  $('#attach').classList.remove('hidden');
}
function closeAttach() { $('#attach').classList.add('hidden'); }

async function copyText(text, btn) {
  const orig = btn.textContent;
  let ok = false;
  // Clipboard API needs a secure context (https); the LAN vhost is TLS, but plain
  // http (localhost testing) is not — so fall back to the textarea+execCommand trick.
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* fall through to fallback */ }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { /* give up */ }
  }
  btn.textContent = ok ? 'Copied!' : 'Copy failed';
  setTimeout(() => { btn.textContent = orig; }, 1500);
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
  lastHistory = data.entries || []; // remembered for the Restart action's params
  renderRecent();
}

// Render the Recent-sessions panel. Currently-running sessions live in the top
// panel, so they're excluded here to avoid showing them twice; then the name
// search is applied.
function renderRecent() {
  let entries = (lastHistory || []).filter((e) => !runningNames.has(e.name));
  if (searchQuery) entries = entries.filter((e) => matchesSearch(e.name));

  if (!entries.length) {
    const msg = searchQuery
      ? 'No recent sessions match your search.'
      : 'No recent sessions.';
    $('#history').innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  $('#history').innerHTML = entries
    .map((e) => {
      const permLabel = e.permissionMode || 'auto';
      const sandboxTag = e.sandbox ? '<span class="tag docker">docker</span>' : '';
      return `
        <div class="session h-session">
          <span class="sw-status"></span>
          <div class="sw-main">
            <div class="sw-name">
              ${escapeHtml(e.name)}
              <span class="tag">${escapeHtml(permLabel)}</span>
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
            >Resume</button>
            <button class="btn btn-danger btn-forget"
              data-del-name="${escapeHtml(e.name)}"
              data-del-dir="${escapeHtml(e.dir)}"
              title="Forget this session (frees the name; the conversation on disk is kept)"
            >Delete</button>
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
  // A new session can't reuse a running window's name (the server also enforces
  // this); catch it here for instant feedback. Resume is exempt.
  if (!resume && runningNames.has(name)) {
    $('#name-hint').classList.add('bad');
    $('#name-hint').textContent = `A session named "${name}" is already running. Pick a different name.`;
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
  $('#claude-only').addEventListener('change', (e) => { claudeOnly = e.target.checked; renderRunning(); });

  // Search filters both panels from cached data — no refetch per keystroke.
  $('#search').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderRunning();
    renderRecent();
  });

  // "Build now" inside the Docker hint (delegated — the button is re-rendered).
  $('#docker-hint').addEventListener('click', (e) => {
    const b = e.target.closest('#build-img-btn');
    if (b) buildImageNow(b);
  });
  // Toggling the sandbox checkbox shows/hides the dependent KVM option.
  $('#f-docker').addEventListener('change', setupKvmField);

  // Turn spaces into hyphens as the user types. Session names can't contain
  // spaces (they become the tmux window / remote-control id); new folder names
  // follow the same convention. Space→hyphen is 1:1, so the caret is preserved.
  const hyphenateOnInput = (el) => el.addEventListener('input', () => {
    if (el.value.includes(' ')) {
      const pos = el.selectionStart;
      el.value = el.value.replace(/ /g, '-');
      el.setSelectionRange(pos, pos);
    }
  });
  hyphenateOnInput($('#f-name'));
  hyphenateOnInput($('#newdir-name'));

  // Close handlers
  document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  document.querySelectorAll('[data-close-picker]').forEach((el) => el.addEventListener('click', closePicker));
  document.querySelectorAll('[data-close-attach]').forEach((el) => el.addEventListener('click', closeAttach));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closePicker(); closeAttach(); }
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') closePicker(); });
  $('#attach').addEventListener('click', (e) => { if (e.target.id === 'attach') closeAttach(); });

  // Session row clicks: Restart button, or (on the row itself) the attach popup.
  $('#sessions').addEventListener('click', (e) => {
    const rc = e.target.closest('[data-restart]');
    if (rc) { restartSession(rc); return; }
    if (e.target.closest('button')) return; // Kill etc. have their own handlers
    const row = e.target.closest('[data-win]');
    if (row) openAttachModal(row.dataset.win, row.dataset.winName);
  });
  $('#attach-copy').addEventListener('click', (e) => copyText($('#attach-cmd').textContent, e.currentTarget));
  $('#attach-copy-alt').addEventListener('click', (e) => copyText($('#attach-cmd-alt').textContent, e.currentTarget));

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
    // Delete (forget) a remembered session, with confirmation.
    const del = e.target.closest('[data-del-name]');
    if (del) {
      const dName = del.dataset.delName;
      const dDir = del.dataset.delDir;
      if (!confirm(`Delete "${dName}" from recent sessions?\n\nThis frees the name for reuse. The conversation on disk is kept and can still be resumed if you recreate the session with the same name and directory.`)) return;
      del.disabled = true;
      try {
        await api('api/history', { method: 'DELETE', body: JSON.stringify({ name: dName, dir: dDir }) });
        banner(`Deleted "${dName}" from recent.`, 'success');
        await loadHistory();
      } catch (err) {
        banner(`Failed to delete: ${err.message}`, 'error');
        del.disabled = false;
      }
      return;
    }

    const btn = e.target.closest('[data-h-name]');
    if (!btn) return;
    const name = btn.dataset.hName;
    const directory = btn.dataset.hDir;
    const permissionMode = btn.dataset.hPerm || 'auto';
    const sandbox = btn.dataset.hSandbox === '1';
    const kvm = btn.dataset.hKvm === '1';
    // The tmux session must be created to resume; optionally add autoclaude to
    // it. This choice is ONLY about autoclaude — the resume happens either way,
    // so the wording spells out what Cancel does (resume without autoclaude).
    let startAutoclaude = false;
    if (config.autoclaudeAvailable && !sessionExists) {
      startAutoclaude = confirm(
        'The tmux session isn’t running — resuming will start it.\n\n' +
        'Also start autoclaude in the new session?\n\n' +
        'OK = start autoclaude too   ·   Cancel = resume without autoclaude'
      );
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
