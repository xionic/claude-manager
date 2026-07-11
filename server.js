'use strict';

/*
 * Claude Manager
 *
 * Small web service that manages Claude Code sessions living as tmux windows.
 * It runs as the user that owns the tmux server (so it can talk to that server
 * natively) and binds to localhost only. Put a reverse proxy in front for TLS,
 * auth and LAN restriction. The service never sends prompts to Claude; it only
 * spawns, lists and kills windows. All spawn parameters are strictly validated
 * so the tmux command line can never be injected.
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

// --- Docker sandbox ---
// When a session is created with `sandbox: true`, the tmux window runs `claude`
// *inside* a container built from docker/Dockerfile instead of on the host.
const DOCKER_BIN = process.env.CM_DOCKER_BIN || 'docker';
const DOCKER_IMAGE = process.env.CM_DOCKER_IMAGE || 'claude-sandbox:latest';
const DOCKER_DIR = process.env.CM_DOCKER_DIR || path.join(__dirname, 'docker');
// The unprivileged user (and its home) inside the sandbox image — must match
// docker/Dockerfile. Centralised so the volume mount, resume check and
// credential sync can never drift apart again (as they did when the image user
// was renamed pi → claude but the image wasn't rebuilt).
const SANDBOX_USER = process.env.CM_SANDBOX_USER || 'claude';
const SANDBOX_HOME = process.env.CM_SANDBOX_HOME || `/home/${SANDBOX_USER}`;
// The host credentials file mounted read-only into the container so the
// sandboxed Claude is already authenticated. Empty string disables the mount.
const CLAUDE_CREDS =
  process.env.CM_CLAUDE_CREDS || path.join(os.homedir(), '.claude', '.credentials.json');
// How often (minutes) to copy the host credentials into running sandbox
// containers, so their isolated copy never goes stale and Claude inside doesn't
// get logged out when the host rotates the OAuth token. 0 disables the sync.
const CREDS_SYNC_MIN = parseInt(process.env.CM_CREDS_SYNC_MIN || '15', 10);
// The daemon socket is only reachable by members of the `docker` group. The
// long-running tmux server (and possibly this service) may have been started
// before that membership existed, so every docker invocation — ours and the
// ones in spawned tmux windows — is wrapped in `sg docker -c` to apply the
// group fresh. `sg` is a no-op for processes that already have the group.
const SG_BIN = process.env.CM_SG_BIN || 'sg';
const DOCKER_GROUP = process.env.CM_DOCKER_GROUP || 'docker';

// --- autoclaude ---
// Optional companion that auto-continues sessions when the usage limit resets.
// We only offer to launch it when its binary resolves on PATH.
const AUTOCLAUDE_BIN = process.env.CM_AUTOCLAUDE_BIN || 'autoclaude';

// Binary used to inspect socket state, for the "remote control connected?"
// check. Remote control is a persistent TLS connection to Anthropic; a window
// whose claude has no established :443 connection is alive but disconnected.
const SS_BIN = process.env.CM_SS_BIN || 'ss';

// --- KVM passthrough ---
// A sandbox session can opt in to hardware virtualisation (e.g. to boot an
// x86_64 Android AVD) by mapping the host's /dev/kvm into the container. The
// device is group-owned (gid varies by distro), so the container process also
// needs that gid as a supplementary group to actually use it.
const KVM_DEVICE = process.env.CM_KVM_DEVICE || '/dev/kvm';
// tmux default socket for this uid; matches a plain `tmux` invocation.
const TMUX_SOCKET =
  process.env.CM_TMUX_SOCKET ||
  path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, 'default');
// The socket a bare `tmux` uses. If we're on it, the copy-paste attach command
// needs no `-S`; otherwise it must include one so the user reaches our server.
const TMUX_SOCKET_DEFAULT = path.join(
  process.env.TMUX_TMPDIR || '/tmp',
  `tmux-${process.getuid()}`,
  'default'
);
const TMUX_SOCKET_ARG = TMUX_SOCKET === TMUX_SOCKET_DEFAULT ? '' : `-S ${TMUX_SOCKET}`;

const ALLOWED_ROOTS = (process.env.CM_ALLOWED_ROOTS || os.homedir())
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

// --- Memory history log ----------------------------------------------------
// Periodic per-session memory samples appended to a TSV so you can go back and
// see which session ate the RAM before a freeze. Columns:
//   ISO-8601 time \t pid \t mem(MB) \t foreground-cmd \t window-name
// Rotated to <file>.1 once it passes MEM_LOG_MAX_BYTES. Set the interval to 0
// to disable logging entirely.
const MEM_LOG = process.env.CM_MEM_LOG || path.join(os.homedir(), '.claude-manager-memory.log');
const MEM_LOG_INTERVAL_MS = parseInt(process.env.CM_MEM_LOG_INTERVAL_MS || '60000', 10);
const MEM_LOG_MAX_BYTES = parseInt(process.env.CM_MEM_LOG_MAX || String(5 * 1024 * 1024), 10);

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

// Resident memory (bytes) of a tmux pane's whole process subtree, read from its
// cgroup. Debian's tmux puts each pane in its own transient systemd scope
// (tmux-spawn-<uuid>.scope), so that scope's memory.current is the exact live
// total for the session — the claude process plus every child it spawns (bash,
// tool subprocesses, subagents). This is what runs the box out of RAM, so it's
// the number worth watching. Returns bytes, or null when it can't be read:
// the pane just exited (race), or — for a sandbox session — the real work runs
// in the container's own cgroup, not the pane's, so this undercounts those (the
// pane only holds the small `docker run` client). cgroup v2 only.
async function paneMemoryBytes(panePid) {
  const pid = parseInt(panePid, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // cgroup v2 gives a single "0::<path>" line for the process.
    const cg = await fsp.readFile(`/proc/${pid}/cgroup`, 'utf8');
    const m = cg.match(/^0::(.*)$/m);
    if (!m) return null;
    const memFile = path.join('/sys/fs/cgroup', m[1], 'memory.current');
    const bytes = parseInt((await fsp.readFile(memFile, 'utf8')).trim(), 10);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

// Set of local pids that currently hold an established TLS (:443) connection —
// used to tell a genuinely remote-control-connected claude from one whose
// process is alive but whose connection to Anthropic has dropped. Returns null
// if ss is unavailable (so callers treat connectivity as "unknown", not "down").
function connectedPids() {
  return new Promise((resolve) => {
    execFile(SS_BIN, ['-tnpH'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const pids = new Set();
      for (const line of stdout.split('\n')) {
        if (!line.includes('ESTAB') || !/:443\b/.test(line)) continue;
        const matches = line.match(/pid=(\d+)/g);
        if (matches) for (const m of matches) pids.add(parseInt(m.slice(4), 10));
      }
      resolve(pids);
    });
  });
}

// --- Docker helpers --------------------------------------------------------

// Single-quote a value for safe inclusion in a /bin/sh command string. Because
// `sg <group> -c <string>` runs its argument through a shell, we build that
// string ourselves and quote every field so a directory name with spaces (or
// anything else) can never break out. `'\''` is the standard way to embed a
// literal single quote inside a single-quoted string.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Turn a docker argv (e.g. ['image','inspect',IMAGE]) into the argv for
// `execFile`/tmux that runs it under the docker group: sg docker -c "docker …".
function dockerCmd(dockerArgs) {
  const shell = `${shq(DOCKER_BIN)} ${dockerArgs.map(shq).join(' ')}`;
  return [SG_BIN, DOCKER_GROUP, '-c', shell];
}

// Run a docker command (server-side, non-interactive) and resolve stdout.
function runDocker(dockerArgs, { timeout = 15000 } = {}) {
  const [bin, ...rest] = dockerCmd(dockerArgs);
  return new Promise((resolve, reject) => {
    execFile(bin, rest, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// Is the docker daemon reachable (binary present, socket accessible)?
async function dockerAvailable() {
  try {
    await runDocker(['version', '--format', '{{.Server.Version}}'], { timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

async function dockerImageExists() {
  try {
    await runDocker(['image', 'inspect', DOCKER_IMAGE], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// Build claude-sandbox:latest from docker/. Slow (minutes) on first run, so the
// timeout is generous. Only called when the image is missing.
let buildInFlight = null;
function ensureDockerImage() {
  if (buildInFlight) return buildInFlight;
  buildInFlight = (async () => {
    if (await dockerImageExists()) return;
    console.log(`[docker] building ${DOCKER_IMAGE} from ${DOCKER_DIR} …`);
    await runDocker(['build', '-t', DOCKER_IMAGE, DOCKER_DIR], { timeout: 20 * 60 * 1000 });
    console.log(`[docker] built ${DOCKER_IMAGE}`);
  })().finally(() => {
    buildInFlight = null;
  });
  return buildInFlight;
}

// Names of the sandbox containers we run that are currently up.
async function listSandboxContainers() {
  try {
    const out = await runDocker(
      ['ps', '--filter', 'name=claude-sandbox-', '--format', '{{.Names}}'],
      { timeout: 10000 }
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Copy the host's current credentials into every running sandbox container so
// their isolated ~/.claude copy tracks the host and Claude inside stays logged
// in. `docker cp` writes into the container's own fs (unlike a bind mount, it
// isn't defeated by the atomic-rename the credentials writer uses). Host file is
// uid 1000 (== the container's `pi`), so ownership carries over; we still fix it
// defensively in case docker cp lands it as root.
async function syncCredsToSandboxes() {
  if (!CLAUDE_CREDS || !fs.existsSync(CLAUDE_CREDS)) return 0;
  const containers = await listSandboxContainers();
  let ok = 0;
  for (const c of containers) {
    try {
      await runDocker(['cp', CLAUDE_CREDS, `${c}:${SANDBOX_HOME}/.claude/.credentials.json`], { timeout: 15000 });
      await runDocker(
        ['exec', '-u', 'root', c, 'chown', `${SANDBOX_USER}:${SANDBOX_USER}`, `${SANDBOX_HOME}/.claude/.credentials.json`],
        { timeout: 10000 }
      ).catch(() => {});
      ok++;
    } catch (err) {
      console.error(`creds sync -> ${c} failed: ${(err.stderr || err.message || '').trim()}`);
    }
  }
  if (ok) console.log(`[creds] synced credentials into ${ok} sandbox container(s)`);
  return ok;
}

// Is /dev/kvm present on the host, and what group owns it? Returns
// { available, gid } — gid is the numeric group needed as a supplementary group
// so the container's non-root user can open the device.
function kvmInfo() {
  try {
    const st = fs.statSync(KVM_DEVICE);
    if (!st.isCharacterDevice()) return { available: false, gid: null };
    return { available: true, gid: st.gid };
  } catch {
    return { available: false, gid: null };
  }
}

// Deterministic, docker-safe names derived from the session identity (name+dir).
// The container name is human-readable; a short hash keeps two same-named
// sessions in different directories from colliding. The home volume persists
// Claude's per-session history so `--resume <uuid>` works across restarts.
function sandboxNames(name, dir) {
  const hash = crypto.createHash('sha1').update(`${name}\0${dir}`).digest('hex');
  const clean = name.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '') || 'session';
  return {
    container: `claude-sandbox-${clean}-${hash.slice(0, 6)}`,
    homeVolume: `claude-mgr-home-${hash.slice(0, 16)}`,
  };
}

// Does the sandbox home volume actually contain the saved conversation for this
// session UUID? A remembered UUID whose session never got written (e.g. the
// first run died on a prompt) would make `claude --resume` hard-fail and the
// tmux window vanish. Claude stores sessions at ~/.claude/projects/<enc>/<uuid>.jsonl;
// we glob across encodings. Runs a throwaway container mounting just the volume.
async function sandboxSessionSaved(volume, uuid) {
  try {
    await runDocker(
      [
        'run', '--rm', '-v', `${volume}:${SANDBOX_HOME}/.claude`, DOCKER_IMAGE,
        'bash', '-lc', `ls ${SANDBOX_HOME}/.claude/projects/*/${uuid}.jsonl >/dev/null 2>&1`,
      ],
      { timeout: 20000 }
    );
    return true; // exit 0 → the session file exists
  } catch {
    return false;
  }
}

// Map running-container name -> host init PID (State.Pid), for reading each
// container's cgroup memory. One `docker ps` + one `docker inspect` over only
// the running containers, so a stale/dead session name can never break the
// batch (missing names simply won't appear). With the systemd cgroup driver the
// init PID's cgroup is the container's own docker-<id>.scope, whose
// memory.current is the full container total — the same metric paneMemoryBytes
// reads for host panes. Empty map if docker is down or nothing is running.
async function containerInitPids() {
  const map = new Map();
  try {
    const ids = (await runDocker(['ps', '-q'], { timeout: 6000 }))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) return map;
    const out = await runDocker(
      ['inspect', '-f', '{{.Name}}\t{{.State.Pid}}', ...ids],
      { timeout: 8000 }
    );
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const name = line.slice(0, tab).replace(/^\//, ''); // docker prefixes '/'
      const pid = parseInt(line.slice(tab + 1), 10);
      if (name && Number.isInteger(pid) && pid > 0) map.set(name, pid);
    }
  } catch {
    /* docker unavailable / none running — undercount rather than fail */
  }
  return map;
}

// Resolve a bare command name to an absolute path on PATH (executable regular
// file). Returns the path or null. Used to gate the autoclaude option and to
// hand tmux an absolute path (its own env PATH may differ from ours).
function binaryOnPath(bin) {
  if (bin.includes('/')) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
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
async function rememberSession(name, dir, uuid, permissionMode, sandbox = false, kvm = false) {
  const state = await loadState();
  state.sessions[sessionKey(name, dir)] = uuid;
  state.history = state.history.filter((e) => !(e.name === name && e.dir === dir));
  state.history.unshift({
    name, dir, uuid, permissionMode, sandbox: !!sandbox, kvm: !!kvm, lastUsed: Date.now(),
  });
  if (state.history.length > 50) state.history.length = 50;
  await writeJsonAtomic(STATE_FILE, state);
}
async function lookupSession(name, dir) {
  const state = await loadState();
  return state.sessions[sessionKey(name, dir)] || null;
}

// Create the tmux session if it doesn't exist (also starts the server if dead).
// Returns { created } — true when this call brought the session into being, so
// the caller can offer to start autoclaude in a genuinely fresh session.
async function ensureTmuxSession() {
  try {
    await tmux(['has-session', '-t', TMUX_SESSION]);
    return { created: false };
  } catch {
    await tmux(['new-session', '-d', '-s', TMUX_SESSION]);
    return { created: true };
  }
}

async function tmuxSessionExists() {
  try {
    await tmux(['has-session', '-t', TMUX_SESSION]);
    return true;
  } catch {
    return false;
  }
}

// Launch autoclaude as its own window in the target session, best-effort. Only
// called when the binary resolved and the session was just created.
async function startAutoclaudeWindow() {
  const bin = binaryOnPath(AUTOCLAUDE_BIN);
  if (!bin) return false;
  try {
    await tmux(['new-window', '-t', `${TMUX_SESSION}:`, '-n', 'autoclaude', bin]);
    return true;
  } catch (err) {
    console.error(`starting autoclaude failed: ${(err.stderr || err.message || '').trim()}`);
    return false;
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

// Collect the windows in the target tmux session, with per-session memory.
// Shared by the GET /api/sessions handler and the memory-history sampler.
// Returns { session, available, windows, error? } and never throws for the
// expected "no tmux server yet" case.
async function gatherSessions() {
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
    // Pane pid — matched against the set of pids holding a live TLS connection
    // to tell "remote control connected" from "process alive but disconnected".
    '#{pane_pid}',
    // User options we stamp on windows we create (empty for foreign windows).
    // @cm_claude marks a Claude session even when its foreground process is
    // `docker` (sandbox mode); @cm_sandbox flags that it's containerised.
    '#{@cm_claude}',
    '#{@cm_sandbox}',
    // The sandbox container name we stamped on creation. Lets us read the
    // container's own cgroup for memory (the pane only holds the docker client).
    '#{@cm_container}',
    // The command the pane was launched with — a robust fallback for windows
    // created before we tagged them (e.g. an old sandbox window whose
    // foreground process is `docker`, not `claude`). Kept last: it can contain
    // spaces, and split('\t') caps at the fixed leading fields anyway.
    '#{pane_start_command}',
  ].join('\t');

  let out;
  try {
    out = await tmux(['list-windows', '-t', TMUX_SESSION, '-F', FMT]);
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    // "No server running" surfaces in a few different phrasings. After a reboot
    // /tmp is wiped, so the socket file itself is gone and tmux says
    // "error connecting to <socket> (No such file or directory)" — a distinct
    // message that must also be treated as simply "no sessions yet", not a 500.
    if (/can't find session|no server running|failed to connect|error connecting to|no such file or directory/i.test(msg)) {
      return { session: TMUX_SESSION, available: false, error: msg, windows: [] };
    }
    throw err;
  }

  // Which pids currently hold a live TLS connection (null = ss unavailable).
  const pidSet = await connectedPids();

  const windows = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, index, name, cmd, cwd, title, active, activity, panePid, cmClaude, cmSandbox, cmContainer, ...rest] =
        line.split('\t');
      // pane_start_command may itself contain tabs; rejoin the tail.
      const startCmd = rest.join('\t');
      // A sandbox window runs `docker`/`sg`, not `claude`. Recognise it from our
      // tag, or (for windows created before tagging) from the start command.
      const looksSandbox = /\bdocker\b/.test(startCmd) && /\brun\b/.test(startCmd);
      const sandbox = cmSandbox === '1' || looksSandbox;
      // Container name: our tag, or (for pre-tag windows) parsed from --name in
      // the start command — the same fallback killSession uses.
      let container = cmContainer || '';
      if (sandbox && !container) {
        const m = startCmd.replace(/'/g, ' ').match(/--name\s+(claude-sandbox-\S+)/);
        if (m) container = m[1];
      }
      const isClaude = cmd === 'claude' || cmClaude === '1' || (looksSandbox && /\bclaude\b/.test(startCmd));

      // Is remote control actually connected? Only meaningful for a host claude
      // (a sandbox's claude runs in the container's own net namespace, so its
      // connection isn't owned by the pane pid) and only when ss succeeded.
      // null = unknown; true = connected; false = process alive but disconnected.
      let remoteConnected = null;
      if (pidSet && isClaude && !sandbox) {
        remoteConnected = pidSet.has(parseInt(panePid, 10));
      }

      return {
        id,
        index: parseInt(index, 10),
        name,
        command: cmd,
        cwd,
        title,
        active: active === '1',
        isClaude,
        sandbox,
        remoteConnected,
        lastActivity: parseInt(activity, 10) || null,
        pid: parseInt(panePid, 10) || null,
        container: container || null,
      };
    });

  // Per-session memory (cgroup memory.current). Host sessions: read the pane's
  // own scope. Sandbox sessions: the pane only holds the `docker run` client —
  // the real work lives in the container's cgroup — so resolve each container's
  // host init PID (one docker call for all of them) and read that scope instead.
  const sandboxed = windows.filter((w) => w.sandbox && w.container);
  const containerPids = sandboxed.length ? await containerInitPids() : new Map();
  await Promise.all(
    windows.map(async (w) => {
      if (w.sandbox && w.container) {
        const cpid = containerPids.get(w.container);
        w.memoryBytes = cpid ? await paneMemoryBytes(cpid) : null;
      } else {
        w.memoryBytes = await paneMemoryBytes(w.pid);
      }
    })
  );

  return { session: TMUX_SESSION, available: true, windows };
}

// GET /api/sessions — list windows in the target tmux session.
async function listSessions(req, res) {
  sendJson(res, 200, await gatherSessions());
}

// Permission modes we expose, mapped to how they reach the claude CLI. All keys
// are passed verbatim to `--permission-mode` except bypassPermissions, which
// uses the explicit --dangerously-skip-permissions flag.
const PERMISSION_MODES = new Set(['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions']);
const DEFAULT_PERMISSION_MODE = 'auto';

// Build the trailing `claude …` arguments shared by host and sandbox modes:
// remote control, permission handling, and resume/new-session targeting. The
// resolved sessionId (existing or freshly minted) is returned alongside so the
// caller can persist it.
async function buildClaudeArgs(name, dir, resume, permissionMode, sandbox, kvm) {
  const args = ['claude', '--remote-control', name];
  if (permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', permissionMode);
  }

  let sessionId = null;
  if (resume) {
    sessionId = await lookupSession(name, dir);
    // In a sandbox a remembered UUID only resumes if it was actually written to
    // the volume; otherwise `--resume` fails and the window dies. Verify first.
    if (sessionId && sandbox) {
      const { homeVolume } = sandboxNames(name, dir);
      if (!(await sandboxSessionSaved(homeVolume, sessionId))) sessionId = null;
    }
    if (sessionId) {
      args.push('--resume', sessionId);
      await rememberSession(name, dir, sessionId, permissionMode, sandbox, kvm); // refresh lastUsed
    } else if (sandbox) {
      // Nothing safely resumable in the volume — start a fresh session so the
      // window always launches (a sandbox `--continue` would also hard-fail).
      sessionId = crypto.randomUUID();
      args.push('--session-id', sessionId);
      await rememberSession(name, dir, sessionId, permissionMode, sandbox, kvm);
    } else {
      // Host: nothing remembered — fall back to "most recent in this directory".
      args.push('--continue');
    }
  } else {
    sessionId = crypto.randomUUID();
    args.push('--session-id', sessionId);
    await rememberSession(name, dir, sessionId, permissionMode, sandbox, kvm);
  }
  return { args, sessionId };
}

// The tmux window command for a sandboxed session: run claude inside a fresh
// container (via `sg docker -c`), mounting the project at /workspace, the host
// credentials read-only, and a persistent per-session volume for Claude's home
// so resume works across container restarts. Inside the container cwd is always
// /workspace, so `--session-id`/`--resume` args (from buildClaudeArgs) apply
// there. Every field is shell-quoted by dockerCmd()/shq(), so the canonical
// `dir` (which may contain spaces) and validated `name` can't inject.
function sandboxWindowCmd(name, dir, claudeArgs, kvm) {
  const { container, homeVolume } = sandboxNames(name, dir);
  const runArgs = [
    'run', '-it', '--rm',
    '--name', container,
    '--hostname', container,
    '-v', `${dir}:/workspace`,
  ];
  if (CLAUDE_CREDS && fs.existsSync(CLAUDE_CREDS)) {
    runArgs.push('-v', `${CLAUDE_CREDS}:/run/claude-creds/.credentials.json:ro`);
  }
  // Map /dev/kvm in and grant its owning group so the container user can open
  // it (device is mode 0660, group-owned).
  if (kvm) {
    const { available, gid } = kvmInfo();
    if (available) {
      runArgs.push('--device', KVM_DEVICE);
      if (gid != null) runArgs.push('--group-add', String(gid));
    }
  }
  runArgs.push(
    '-v', `${homeVolume}:${SANDBOX_HOME}/.claude`,
    '-w', '/workspace',
    DOCKER_IMAGE,
    // claudeArgs[0] === 'claude' — the container entrypoint runs it directly.
    ...claudeArgs
  );
  return { cmd: dockerCmd(runArgs), container };
}

// POST /api/sessions — spawn a new Claude window (on the host, or in a Docker
// sandbox when `sandbox` is set).
// body: { name, directory, resume?:bool, permissionMode?:string,
//         sandbox?:bool, startAutoclaude?:bool }
async function createSession(req, res) {
  const body = await readBody(req);
  const name = String(body.name || '').trim();
  const directory = String(body.directory || '').trim();
  const resume = body.resume === true;
  const sandbox = body.sandbox === true;
  const kvm = body.kvm === true;
  const startAutoclaude = body.startAutoclaude === true;
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

  // Reject a duplicate name for a brand-new session — two running windows sharing
  // one name would both answer to the same remote-control id. Resume flows re-use
  // the name on purpose (restart kills the old window first), so they're exempt.
  if (!resume) {
    try {
      const running = (await tmux(['list-windows', '-t', TMUX_SESSION, '-F', '#{window_name}']))
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (running.includes(name)) {
        return sendJson(res, 409, {
          error: `A session named "${name}" is already running. Pick a different name, or resume it from Recent.`,
        });
      }
    } catch {
      /* no tmux session yet → nothing running → no possible duplicate */
    }
  }

  // Pre-seed the trust flag so the window doesn't block on the trust dialog.
  // Best-effort: a failure here shouldn't stop us spawning. (Harmless in
  // sandbox mode too — the container has its own home, but it costs nothing.)
  try {
    await ensureTrusted(dir);
  } catch (err) {
    console.error(`ensureTrusted(${dir}) failed: ${err.message}`);
  }

  const { args: claudeArgs, sessionId } =
    await buildClaudeArgs(name, dir, resume, permissionMode, sandbox, kvm);

  // Decide the window command. Host mode runs `claude` directly (claudeArgs
  // start with the literal 'claude'; swap in the configured binary). Sandbox
  // mode wraps it in a docker run. Because `name` matches NAME_RE and `dir` is
  // a canonical path inside an allowed root, nothing here can break out.
  let windowCmd;
  let container = null;
  if (sandbox) {
    if (!(await dockerAvailable())) {
      return sendJson(res, 503, {
        error: 'Docker is not available (daemon unreachable or the service lacks docker-group access).',
      });
    }
    try {
      await ensureDockerImage();
    } catch (err) {
      const msg = (err.stderr || err.message || '').trim();
      return sendJson(res, 500, { error: `Building the sandbox image failed: ${msg}` });
    }
    // Clear any orphaned container of the same name from a previous run; the
    // persistent home volume keeps the session history regardless.
    ({ cmd: windowCmd, container } = sandboxWindowCmd(name, dir, claudeArgs, kvm));
    await runDocker(['rm', '-f', container], { timeout: 20000 }).catch(() => {});
  } else {
    windowCmd = [CLAUDE_BIN, ...claudeArgs.slice(1)];
  }

  // Ensure the tmux session exists even if the server was restarted. If we just
  // created it and the caller asked, launch autoclaude in the fresh session.
  let autoclaudeStarted = false;
  try {
    const { created } = await ensureTmuxSession();
    if (created && startAutoclaude) {
      autoclaudeStarted = await startAutoclaudeWindow();
    }
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
        ...windowCmd,
      ])
    ).trim();
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    return sendJson(res, 500, { error: `tmux failed: ${msg}` });
  }

  // Mark the window as ours so the UI recognises it as a Claude session even in
  // sandbox mode (foreground process `docker`) and can badge it. We also stash
  // the container name so killing the window can tear the container down too.
  // Best-effort.
  try {
    await tmux(['set-option', '-t', windowId, '-w', '@cm_claude', '1']);
    await tmux(['set-option', '-t', windowId, '-w', '@cm_sandbox', sandbox ? '1' : '0']);
    await tmux(['set-option', '-t', windowId, '-w', '@cm_kvm', sandbox && kvm ? '1' : '0']);
    await tmux(['set-option', '-t', windowId, '-w', '@cm_container', container || '']);
  } catch (err) {
    console.error(`tagging window ${windowId} failed: ${(err.stderr || err.message || '').trim()}`);
  }

  sendJson(res, 201, {
    ok: true, windowId, name, directory: dir, resume, sessionId, permissionMode,
    sandbox, kvm: sandbox && kvm, container, autoclaudeStarted,
  });
}

// POST /api/sessions/:windowId/kill — kill a window (and its sandbox container,
// if any). Removing the container is safe: the conversation history lives in the
// persistent home volume and the project on the host bind-mount, neither of
// which is touched — only the container instance is removed.
async function killSession(req, res, windowId) {
  if (!/^@?\d+$/.test(windowId)) {
    return sendJson(res, 400, { error: 'Invalid window id.' });
  }
  const target = windowId.startsWith('@') ? windowId : `@${windowId}`;

  // Figure out the container to tear down before killing the window (its options
  // vanish with it). Prefer our @cm_container tag; for windows created before
  // tagging, pull the name straight out of the pane's start command, which
  // still carries the `--name claude-sandbox-…` we launched it with. A miss just
  // means `docker rm` finds nothing — harmless.
  let container = '';
  try {
    const out = await tmux([
      'display-message', '-p', '-t', target,
      '#{@cm_container}\t#{pane_start_command}',
    ]);
    // Split on the FIRST tab only (start command may contain tabs/anything), and
    // don't .trim() — that would eat the leading empty field when the tag is
    // unset and misalign the columns.
    const nl = out.replace(/\r?\n$/, '');
    const tab = nl.indexOf('\t');
    const tagged = tab >= 0 ? nl.slice(0, tab) : '';
    const startCmd = tab >= 0 ? nl.slice(tab + 1) : nl;
    if (tagged) {
      container = tagged;
    } else {
      // The command is shell-quoted (…'--name' 'claude-sandbox-x'…); drop quotes
      // then grab the token after --name that we know is a sandbox container.
      const m = startCmd.replace(/'/g, ' ').match(/--name\s+(claude-sandbox-\S+)/);
      if (m) container = m[1];
    }
  } catch {
    /* foreign window / older tmux — nothing to tear down */
  }

  try {
    await tmux(['kill-window', '-t', target]);
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    return sendJson(res, 500, { error: `tmux failed: ${msg}` });
  }

  let containerRemoved = false;
  if (container) {
    try {
      await runDocker(['rm', '-f', container], { timeout: 20000 });
      containerRemoved = true;
    } catch (err) {
      console.error(`removing container ${container} failed: ${(err.stderr || err.message || '').trim()}`);
    }
  }

  sendJson(res, 200, { ok: true, killed: target, container: container || null, containerRemoved });
}

// GET /api/history — list remembered sessions, most recent first.
async function listHistory(req, res) {
  const state = await loadState();
  sendJson(res, 200, { entries: state.history });
}

// GET /api/config — capabilities the UI uses to show/hide options. Docker and
// tmux-session state are probed live so the UI reflects reality.
async function getConfig(req, res) {
  const dockerOk = await dockerAvailable();
  const [imageReady, sessionExists] = await Promise.all([
    dockerOk ? dockerImageExists() : Promise.resolve(false),
    tmuxSessionExists(),
  ]);
  sendJson(res, 200, {
    session: TMUX_SESSION,
    socketArg: TMUX_SOCKET_ARG,
    roots: ALLOWED_ROOTS,
    dockerAvailable: dockerOk,
    dockerImageReady: imageReady,
    dockerBuilding: buildInFlight !== null,
    kvmAvailable: kvmInfo().available,
    autoclaudeAvailable: binaryOnPath(AUTOCLAUDE_BIN) !== null,
    sessionExists,
  });
}

// POST /api/docker/build — build the sandbox image on demand (so the user can
// pre-build with the UI rather than blocking the first session on it).
async function buildDockerImage(req, res) {
  if (!(await dockerAvailable())) {
    return sendJson(res, 503, { error: 'Docker is not available.' });
  }
  try {
    await ensureDockerImage();
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    return sendJson(res, 500, { error: `Build failed: ${msg}` });
  }
  sendJson(res, 200, { ok: true, image: DOCKER_IMAGE });
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

// ---------------------------------------------------------------------------
// Memory history sampler
// ---------------------------------------------------------------------------

// Rename the log to <file>.1 once it grows past the cap, so history is bounded
// (one generation kept). Best-effort — a failure just means we keep appending.
async function rotateMemLogIfNeeded() {
  try {
    const st = await fsp.stat(MEM_LOG);
    if (st.size > MEM_LOG_MAX_BYTES) await fsp.rename(MEM_LOG, `${MEM_LOG}.1`);
  } catch {
    /* no file yet, or rename lost a race — fine */
  }
}

// Take one memory sample of every live window and append it. Skipped silently
// when tmux isn't running or there are no windows (nothing to record).
async function sampleMemoryOnce() {
  let data;
  try {
    data = await gatherSessions();
  } catch {
    return; // unexpected tmux error — don't let the timer crash the process
  }
  if (!data.available || !data.windows.length) return;
  const ts = new Date().toISOString();
  const lines = data.windows.map((w) => {
    const mb = w.memoryBytes != null ? (w.memoryBytes / 1048576).toFixed(1) : 'NA';
    return `${ts}\t${w.pid || ''}\t${mb}\t${w.command}\t${w.name}`;
  });
  try {
    await rotateMemLogIfNeeded();
    await fsp.appendFile(MEM_LOG, lines.join('\n') + '\n');
  } catch (err) {
    console.error(`memory log write failed: ${err.message}`);
  }
}

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

    if (pathname === '/api/config' && req.method === 'GET') return await getConfig(req, res);
    if (pathname === '/api/docker/build' && req.method === 'POST') return await buildDockerImage(req, res);

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
  if (MEM_LOG_INTERVAL_MS > 0) {
    console.log(`  memory log  : ${MEM_LOG} (every ${Math.round(MEM_LOG_INTERVAL_MS / 1000)}s)`);
    // First sample shortly after start, then on the interval.
    setTimeout(() => sampleMemoryOnce().catch(() => {}), 5000);
    setInterval(() => sampleMemoryOnce().catch(() => {}), MEM_LOG_INTERVAL_MS);
  }
  if (CREDS_SYNC_MIN > 0) {
    console.log(`  creds sync  : sandbox containers every ${CREDS_SYNC_MIN} min`);
    setTimeout(() => syncCredsToSandboxes().catch(() => {}), 20000);
    setInterval(() => syncCredsToSandboxes().catch(() => {}), CREDS_SYNC_MIN * 60 * 1000);
  }
});
