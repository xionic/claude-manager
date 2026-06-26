'use strict';

/*
 * Claude Manager
 *
 * Small web service that manages Claude Code sessions living as tmux windows.
 * It runs AS the `pi` user (so it can talk to pi's tmux server natively) and
 * binds to localhost only. Apache sits in front for TLS, Basic auth and LAN
 * restriction. The service never sends prompts to Claude; it only spawns,
 * lists and kills windows. All spawn parameters are strictly validated so the
 * tmux command line can never be injected.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Config (override with env vars)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.CM_PORT || '8765', 10);
const BIND = process.env.CM_BIND || '127.0.0.1';
const TMUX_SESSION = process.env.CM_TMUX_SESSION || '0';
const TMUX_BIN = process.env.CM_TMUX_BIN || '/usr/bin/tmux';
const CLAUDE_BIN = process.env.CM_CLAUDE_BIN || 'claude';
// tmux default socket for this uid; matches a plain `tmux` invocation.
const TMUX_SOCKET =
  process.env.CM_TMUX_SOCKET ||
  path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, 'default');

const ALLOWED_ROOTS = (process.env.CM_ALLOWED_ROOTS || '/home/youruser,/var/www/html')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// A single directory-name segment: no slashes, not starting with a dot (so we
// can't create hidden dirs or "."/".."). Spaces are allowed in folder names.
const DIR_NAME_RE = /^(?!\.)[A-Za-z0-9._ -]{1,64}$/;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Claude's per-user config; we pre-seed the per-directory trust flag here so an
// interactive window never blocks on the "Do you trust this folder?" dialog.
const CLAUDE_CONFIG =
  process.env.CM_CLAUDE_CONFIG || path.join(os.homedir(), '.claude.json');
// Where we persist the {name|dir -> session UUID} map so resume targets an
// exact session (no interactive picker).
const STATE_FILE =
  process.env.CM_STATE_FILE || path.join(os.homedir(), '.claude-manager-sessions.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile(TMUX_BIN, ['-S', TMUX_SOCKET, ...args], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// Resolve a user-supplied path, following symlinks, and ensure the real path
// is inside one of the allowed roots. Returns the canonical absolute path or
// throws. `mustBeDir` enforces that it is a directory.
async function resolveWithinRoots(input, mustBeDir = true) {
  const real = await fsp.realpath(path.resolve(input));
  const ok = ALLOWED_ROOTS.some(
    (root) => real === root || real.startsWith(root + path.sep)
  );
  if (!ok) {
    const e = new Error('Path is outside the allowed roots');
    e.statusCode = 403;
    throw e;
  }
  if (mustBeDir) {
    const st = await fsp.stat(real);
    if (!st.isDirectory()) {
      const e = new Error('Path is not a directory');
      e.statusCode = 400;
      throw e;
    }
  }
  return real;
}

// Write JSON atomically: temp file in the same dir, then rename. Avoids leaving
// a half-written ~/.claude.json (which would wipe Claude's config) if we crash
// mid-write.
async function writeJsonAtomic(file, obj) {
  const tmp = `${file}.cm-tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, file);
}

// Ensure Claude already trusts `dir`, so the interactive trust dialog never
// appears. Reads ~/.claude.json, sets projects[dir].hasTrustDialogAccepted, and
// writes it back only if it wasn't already set. Best-effort: failures here must
// not block spawning, so the caller logs and continues.
async function ensureTrusted(dir) {
  let cfg;
  try {
    cfg = JSON.parse(await fsp.readFile(CLAUDE_CONFIG, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    cfg = {};
  }
  if (!cfg.projects || typeof cfg.projects !== 'object') cfg.projects = {};
  const entry = cfg.projects[dir] || {};
  if (entry.hasTrustDialogAccepted === true) return false; // already trusted
  entry.hasTrustDialogAccepted = true;
  // projectOnboardingSeenCount > 0 suppresses the separate onboarding screen.
  if (typeof entry.projectOnboardingSeenCount !== 'number' || entry.projectOnboardingSeenCount < 1) {
    entry.projectOnboardingSeenCount = 1;
  }
  cfg.projects[dir] = entry;
  await writeJsonAtomic(CLAUDE_CONFIG, cfg);
  return true;
}

// Persisted map so a named session in a given dir always resumes the same
// Claude session UUID — no interactive resume picker. Also tracks a history
// list of recent sessions for the UI's one-tap resume feature.
//
// State file format:
//   { sessions: { "name dir": "uuid" }, history: [{ name, dir, uuid, permissionMode, lastUsed }] }
// Old format (flat { "name dir": "uuid" }) is migrated on first read.
function sessionKey(name, dir) {
  return `${name} ${dir}`;
}
async function loadState() {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { sessions: {}, history: [] };
    throw err;
  }
  // Migrate old flat format
  if (!raw.sessions || typeof raw.sessions !== 'object') {
    const sessions = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') sessions[k] = v;
    }
    return { sessions, history: [] };
  }
  return { sessions: raw.sessions || {}, history: Array.isArray(raw.history) ? raw.history : [] };
}
async function rememberSession(name, dir, uuid, permissionMode) {
  const state = await loadState();
  state.sessions[sessionKey(name, dir)] = uuid;
  state.history = state.history.filter((e) => !(e.name === name && e.dir === dir));
  state.history.unshift({ name, dir, uuid, permissionMode, lastUsed: Date.now() });
  if (state.history.length > 50) state.history.length = 50;
  await writeJsonAtomic(STATE_FILE, state);
}
async function lookupSession(name, dir) {
  const state = await loadState();
  return state.sessions[sessionKey(name, dir)] || null;
}

// Create the tmux session if it doesn't exist (also starts the server if dead).
async function ensureTmuxSession() {
  try {
    await tmux(['has-session', '-t', TMUX_SESSION]);
  } catch {
    await tmux(['new-session', '-d', '-s', TMUX_SESSION]);
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

// GET /api/sessions — list windows in the target tmux session.
async function listSessions(req, res) {
  // Use a tab-separated, controlled format so parsing is unambiguous.
  const FMT = [
    '#{window_id}',
    '#{window_index}',
    '#{window_name}',
    '#{pane_current_command}',
    '#{pane_current_path}',
    '#{pane_title}',
    '#{window_active}',
    '#{window_activity}',
  ].join('\t');

  let out;
  try {
    out = await tmux(['list-windows', '-t', TMUX_SESSION, '-F', FMT]);
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    if (/can't find session|no server running|failed to connect/i.test(msg)) {
      return sendJson(res, 200, { session: TMUX_SESSION, available: false, error: msg, windows: [] });
    }
    throw err;
  }

  const windows = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, index, name, cmd, cwd, title, active, activity] = line.split('\t');
      return {
        id,
        index: parseInt(index, 10),
        name,
        command: cmd,
        cwd,
        title,
        active: active === '1',
        isClaude: cmd === 'claude',
        lastActivity: parseInt(activity, 10) || null,
      };
    });

  sendJson(res, 200, { session: TMUX_SESSION, available: true, windows });
}

// Permission modes we expose, mapped to how they reach the claude CLI. All keys
// are passed verbatim to `--permission-mode` except bypassPermissions, which
// uses the explicit --dangerously-skip-permissions flag.
const PERMISSION_MODES = new Set(['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions']);
const DEFAULT_PERMISSION_MODE = 'auto';

// POST /api/sessions — spawn a new Claude window.
// body: { name, directory, resume?:bool, permissionMode?:string }
async function createSession(req, res) {
  const body = await readBody(req);
  const name = String(body.name || '').trim();
  const directory = String(body.directory || '').trim();
  const resume = body.resume === true;
  const permissionMode = String(body.permissionMode || DEFAULT_PERMISSION_MODE).trim();

  if (!PERMISSION_MODES.has(permissionMode)) {
    return sendJson(res, 400, {
      error: `Invalid permission mode. Use one of: ${[...PERMISSION_MODES].join(', ')}.`,
    });
  }
  if (!NAME_RE.test(name)) {
    return sendJson(res, 400, {
      error: 'Invalid session name. Use 1-64 chars: letters, numbers, dot, dash, underscore.',
    });
  }
  if (!directory) {
    return sendJson(res, 400, { error: 'A directory is required.' });
  }

  let dir;
  try {
    dir = await resolveWithinRoots(directory, true);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }

  // Pre-seed the trust flag so the window doesn't block on the trust dialog.
  // Best-effort: a failure here shouldn't stop us spawning.
  try {
    await ensureTrusted(dir);
  } catch (err) {
    console.error(`ensureTrusted(${dir}) failed: ${err.message}`);
  }

  // Build the Claude command as discrete, already-validated arguments. tmux
  // joins them into the window's command line; because `name` matches NAME_RE
  // and `dir` is a canonical path inside an allowed root, nothing here can
  // break out into the surrounding shell.
  const claudeArgs = [CLAUDE_BIN, '--remote-control', name];
  if (permissionMode === 'bypassPermissions') {
    claudeArgs.push('--dangerously-skip-permissions');
  } else {
    claudeArgs.push('--permission-mode', permissionMode);
  }

  // Resume targets a specific, remembered session UUID (no interactive picker).
  // New sessions are created with a UUID we choose, then remembered so a later
  // resume of the same name+dir lands on exactly this session.
  let sessionId = null;
  if (resume) {
    sessionId = await lookupSession(name, dir);
    if (sessionId) {
      claudeArgs.push('--resume', sessionId);
      await rememberSession(name, dir, sessionId, permissionMode); // refresh lastUsed
    } else {
      // Nothing remembered for this name+dir — fall back to "most recent in
      // this directory", which also avoids the picker.
      claudeArgs.push('--continue');
    }
  } else {
    sessionId = crypto.randomUUID();
    claudeArgs.push('--session-id', sessionId);
    await rememberSession(name, dir, sessionId, permissionMode);
  }

  // Ensure the tmux session exists even if the server was restarted.
  try {
    await ensureTmuxSession();
  } catch (err) {
    return sendJson(res, 500, { error: `Could not start tmux session: ${err.message}` });
  }

  let windowId;
  try {
    windowId = (
      await tmux([
        'new-window',
        // Trailing colon = "this session, next free index". Without it tmux
        // would read a numeric session name (e.g. "0") as a window index.
        '-a',
        '-t', `${TMUX_SESSION}:`,
        '-n', name,
        '-c', dir,
        '-P',
        '-F', '#{window_id}',
        ...claudeArgs,
      ])
    ).trim();
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    return sendJson(res, 500, { error: `tmux failed: ${msg}` });
  }

  sendJson(res, 201, { ok: true, windowId, name, directory: dir, resume, sessionId, permissionMode });
}

// POST /api/sessions/:windowId/kill — kill a window.
async function killSession(req, res, windowId) {
  if (!/^@?\d+$/.test(windowId)) {
    return sendJson(res, 400, { error: 'Invalid window id.' });
  }
  const target = windowId.startsWith('@') ? windowId : `@${windowId}`;
  try {
    await tmux(['kill-window', '-t', target]);
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    return sendJson(res, 500, { error: `tmux failed: ${msg}` });
  }
  sendJson(res, 200, { ok: true, killed: target });
}

// GET /api/history — list remembered sessions, most recent first.
async function listHistory(req, res) {
  const state = await loadState();
  sendJson(res, 200, { entries: state.history });
}

// GET /api/browse?path=... — directory picker. Lists subdirectories.
async function browse(req, res, url) {
  const requested = url.searchParams.get('path') || ALLOWED_ROOTS[0];

  let dir;
  try {
    dir = await resolveWithinRoots(requested, true);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }

  let entries = [];
  try {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    entries = dirents
      .filter((d) => {
        if (d.name.startsWith('.')) return false;
        if (d.isDirectory()) return true;
        // follow symlinks that point at directories
        if (d.isSymbolicLink()) {
          try {
            return fs.statSync(path.join(dir, d.name)).isDirectory();
          } catch {
            return false;
          }
        }
        return false;
      })
      .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }

  // Offer a parent link only if the parent is still within an allowed root.
  let parent = null;
  const parentPath = path.dirname(dir);
  if (parentPath !== dir) {
    const inRoots = ALLOWED_ROOTS.some(
      (root) => parentPath === root || parentPath.startsWith(root + path.sep)
    );
    if (inRoots) parent = parentPath;
  }

  sendJson(res, 200, { cwd: dir, parent, roots: ALLOWED_ROOTS, entries });
}

// POST /api/mkdir — create a subdirectory inside an allowed root, e.g. to start
// a new project. body: { parent, name }
async function makeDir(req, res) {
  const body = await readBody(req);
  const parent = String(body.parent || '').trim();
  const name = String(body.name || '').trim();

  if (!parent) {
    return sendJson(res, 400, { error: 'A parent directory is required.' });
  }
  if (!DIR_NAME_RE.test(name)) {
    return sendJson(res, 400, {
      error:
        'Invalid folder name. Use 1-64 chars: letters, numbers, space, dot, dash, underscore (no slashes, not starting with a dot).',
    });
  }

  let parentDir;
  try {
    parentDir = await resolveWithinRoots(parent, true);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }

  // `name` is a single validated segment and `parentDir` is already jailed
  // inside an allowed root, so the target is a direct child that cannot escape.
  const target = path.join(parentDir, name);
  try {
    await fsp.mkdir(target);
  } catch (err) {
    if (err.code === 'EEXIST') {
      return sendJson(res, 409, { error: 'A folder with that name already exists.' });
    }
    return sendJson(res, 500, { error: err.message });
  }
  sendJson(res, 201, { ok: true, path: target });
}

// ---------------------------------------------------------------------------
// Static file serving (the small SPA in public/)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/sessions' && req.method === 'GET') return await listSessions(req, res);
    if (pathname === '/api/sessions' && req.method === 'POST') return await createSession(req, res);

    const killMatch = pathname.match(/^\/api\/sessions\/(.+)\/kill$/);
    if (killMatch && req.method === 'POST') {
      return await killSession(req, res, decodeURIComponent(killMatch[1]));
    }

    if (pathname === '/api/browse' && req.method === 'GET') return await browse(req, res, url);
    if (pathname === '/api/mkdir' && req.method === 'POST') return await makeDir(req, res);

    if (pathname === '/api/history' && req.method === 'GET') return await listHistory(req, res);

    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, { session: TMUX_SESSION, roots: ALLOWED_ROOTS });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Unknown endpoint' });
    }

    return await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, err.statusCode || 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, BIND, () => {
  console.log(`claude-manager listening on http://${BIND}:${PORT}`);
  console.log(`  tmux socket : ${TMUX_SOCKET}`);
  console.log(`  tmux session: ${TMUX_SESSION}`);
  console.log(`  allowed roots: ${ALLOWED_ROOTS.join(', ')}`);
});
