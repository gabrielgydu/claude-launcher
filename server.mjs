// Claude Launcher — tiny zero-dependency server that creates tmux+claude sessions
// on this machine, driven by an installable iOS PWA. See README.md.
import http from 'node:http';
import { readFile, stat, readdir, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync, realpathSync, createWriteStream, rmSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PUBLIC = path.join(__dirname, 'public');
// The override exists for tests, which must never edit the live config.json.
const CONFIG_PATH = process.env.CLAUDE_LAUNCHER_CONFIG
  ? path.resolve(process.env.CLAUDE_LAUNCHER_CONFIG)
  : path.join(__dirname, 'config.json');
const TMUX_OPTS = { timeout: 4000 };

// ---------- config (re-read from disk so edits don't need a restart) ----------
let cachedConfig;
try {
  cachedConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`Fatal: cannot read ${CONFIG_PATH}: ${e.message}`);
  // config.json is local and untracked; a fresh clone only has the example.
  if (e.code === 'ENOENT') console.error('Create it from config.example.json (install.sh does this).');
  process.exit(1);
}
function getConfig() {
  try { cachedConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* keep last good */ }
  return cachedConfig;
}
const PORT = Number(process.env.PORT || cachedConfig.port || 8838);
const HOST = process.env.HOST || cachedConfig.host || '127.0.0.1';

function allowedRoots() {
  const roots = (getConfig().allowedRoots || ['~']).map((p) => path.resolve(expandHome(p)));
  return roots.length ? roots : [HOME];
}

// ---------- path helpers ----------
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}
function tildify(p) {
  if (p === HOME) return '~';
  if (p.startsWith(HOME + path.sep)) return '~' + p.slice(HOME.length);
  return p;
}
function realOrLexical(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}
// Confinement is enforced on the *real* path so a symlink under ~ can't escape.
function isUnderAllowed(p) {
  const r = realOrLexical(path.resolve(p));
  return allowedRoots().some((root) => {
    const rr = realOrLexical(root);
    return r === rr || r.startsWith(rr + path.sep);
  });
}

// ---------- shell / name safety ----------
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
function sanitizeName(s) {
  return String(s || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- tmux ----------
async function tmuxHasSession(name) {
  try { await execFileP('tmux', ['has-session', '-t', '=' + name], TMUX_OPTS); return true; }
  catch { return false; }
}
async function uniqueSessionName(base) {
  const name = base || 'claude';
  if (!(await tmuxHasSession(name))) return name;
  for (let i = 2; i < 1000; i++) {
    const cand = `${name}-${i}`;
    if (!(await tmuxHasSession(cand))) return cand;
  }
  return `${name}-${Date.now()}`;
}
// A `new-session` that finds no tmux server forks one, and the fork inherits this
// process's cgroup. Under systemd that is claude-launcher.service's cgroup, and with
// KillMode=control-group `systemctl --user restart claude-launcher` then kills the
// tmux server — and every session on it, not just the ones launched from here. A
// transient scope around the client gives any server it forks a cgroup of its own.
// Probed once: outside systemd (a dev run from a shell) there is nothing to escape.
let scopeProbe = null;
function useScope() {
  if (!process.env.INVOCATION_ID) return Promise.resolve(false);
  scopeProbe ||= execFileP('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], TMUX_OPTS)
    .then(() => true, (e) => {
      console.error('[tmux] systemd-run --scope unavailable, a tmux server started from here'
        + ` will live in this service's cgroup: ${e.message}`);
      return false;
    });
  return scopeProbe;
}
async function tmuxNewSession(args) {
  if (await useScope()) {
    await execFileP('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'tmux', 'new-session', ...args], TMUX_OPTS);
  } else {
    await execFileP('tmux', ['new-session', ...args], TMUX_OPTS);
  }
}
async function listSessions() {
  try {
    const fmt = '#{session_name}\t#{session_created}\t#{pane_current_path}\t#{session_attached}';
    const { stdout } = await execFileP('tmux', ['list-sessions', '-F', fmt], { timeout: 2000 });
    return stdout.split('\n').filter(Boolean).map((line) => {
      const [name, created, cwd, attached] = line.split('\t');
      return { name, created: Number(created) * 1000, cwd: tildify(cwd || ''), attached: attached !== '0' };
    });
  } catch { return []; }
}

// ---------- directory discovery ----------
async function zoxideQuery(q) {
  try {
    const args = ['query', '--list'];
    if (q) args.push(...q.split(/\s+/).filter(Boolean));
    const { stdout } = await execFileP('zoxide', args, { timeout: 1500, maxBuffer: 4 << 20 });
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
async function fdSearch(q) {
  if (!q) return [];
  try {
    // No --hidden: zoxide already covers dirs you've visited (incl. hidden ones);
    // the filesystem fallback is for *visible* project dirs you've never cd'd into.
    const args = [
      '--type', 'd', '--ignore-case', '--absolute-path', '--max-results', '80',
      '--exclude', 'node_modules', '--exclude', 'vendor',
      q, HOME,
    ];
    const { stdout } = await execFileP('fd', args, { timeout: 2500, maxBuffer: 8 << 20 });
    return stdout.split('\n').map((s) => s.replace(/\/+$/, '')).filter(Boolean)
      // shallowest, then shortest — project roots before deep nested matches.
      .sort((a, b) => (a.split('/').length - b.split('/').length) || (a.length - b.length));
  } catch { return []; }
}
function favorites() {
  return (getConfig().favorites || [])
    .map((f) => ({ path: expandHome(f.path), label: f.label || tildify(expandHome(f.path)), source: 'favorite' }))
    .filter((f) => existsSync(f.path));
}
function models() {
  return (getConfig().models || []).map((m) => ({ id: m.id, label: m.label || m.id, arg: m.arg || m.id }));
}
async function searchDirs(q) {
  q = (q || '').trim();
  if (!q) return favorites();
  const [z, f] = await Promise.all([zoxideQuery(q), fdSearch(q)]);
  const seen = new Set();
  const out = [];
  const add = (p, source) => {
    const rp = path.resolve(p);
    if (seen.has(rp) || !isUnderAllowed(rp) || !existsSync(rp)) return;
    seen.add(rp);
    out.push({ path: rp, label: tildify(rp), source });
  };
  for (const p of z) add(p, 'frecent');
  for (const p of f) add(p, 'filesystem');
  return out.slice(0, 50);
}
async function browse(p) {
  let dir = p ? path.resolve(expandHome(p)) : HOME;
  if (!isUnderAllowed(dir)) dir = HOME;
  let dirs = [];
  try {
    const items = await readdir(dir, { withFileTypes: true });
    dirs = items
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* unreadable dir -> empty */ }
  const parent = path.dirname(dir);
  const showParent = dir !== parent && isUnderAllowed(parent);
  return { path: dir, label: tildify(dir), parent: showParent ? parent : null, dirs };
}

// ---------- launch ----------
let tmpCounter = 0;
async function launch({ dir, name, prompt, mode, model }) {
  dir = expandHome(String(dir || '').trim());
  if (!dir) throw httpErr(400, 'directory required');
  dir = path.resolve(dir);
  let st;
  try { st = await stat(dir); } catch { throw httpErr(400, 'directory does not exist: ' + tildify(dir)); }
  if (!st.isDirectory()) throw httpErr(400, 'not a directory: ' + tildify(dir));
  if (!isUnderAllowed(dir)) throw httpErr(403, 'directory not allowed: ' + tildify(dir));

  const cfg = getConfig();
  const modeDef = (cfg.modes || []).find((m) => m.id === mode) || (cfg.modes || [])[0];
  if (!modeDef) throw httpErr(400, 'no launch modes configured');

  // Model is orthogonal to mode: any mode can start on any configured model.
  // Default to the first configured model; an explicit unknown id is rejected.
  const modelList = models();
  let modelDef = null;
  if (model != null && model !== '') {
    modelDef = modelList.find((m) => m.id === model);
    if (!modelDef) throw httpErr(400, 'unknown model: ' + model);
  } else {
    modelDef = modelList[0] || null;
  }

  const base = sanitizeName(name) || sanitizeName(path.basename(dir)) || 'claude';

  // The initial prompt is written to a private temp file (0600, fail-if-exists) and
  // read with "$(cat FILE)". This keeps the typed command on a single line and is
  // robust to quotes/newlines (the content is data, never interpreted as shell).
  let promptFile = null;
  if (prompt && String(prompt).trim()) {
    promptFile = path.join(os.tmpdir(), `claude-launcher-${process.pid}-${Date.now()}-${tmpCounter++}.txt`);
    await writeFile(promptFile, String(prompt), { mode: 0o600, flag: 'wx' });
  }

  try {
    // Run claude as the pane's *own* command rather than typing it into an interactive
    // shell with send-keys. tmux execs this via `sh -c`, so there's no race against a
    // shell still sourcing its rc — that race silently swallowed the keystrokes (Enter
    // included) and claude never started. `exec $SHELL` leaves a normal interactive
    // shell in the pane once claude exits. The command + session name are built inside
    // the retry loop because --remote-control needs the (possibly bumped) session name.
    const shell = process.env.SHELL || '/bin/sh';
    let session = await uniqueSessionName(base);
    let claudeCmd = '';
    let created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const parts = ['claude', ...(modeDef.args || []).map(shQuote)];
      if (modelDef) parts.push('--model', shQuote(modelDef.arg));
      if (cfg.remoteControl !== false) parts.push('--remote-control', shQuote(session));
      if (promptFile) parts.push(`"$(cat ${shQuote(promptFile)})"`);
      claudeCmd = parts.join(' ');
      const paneCmd = `${claudeCmd}; exec ${shQuote(shell)} -i`;
      try {
        await tmuxNewSession(['-d', '-s', session, '-c', dir, paneCmd]);
        created = true;
      } catch (e) {
        if (await tmuxHasSession(session)) { session = await uniqueSessionName(`${base}-${attempt + 2}`); continue; }
        throw httpErr(500, 'failed to create tmux session: ' + e.message);
      }
    }
    if (!created) throw httpErr(500, 'could not allocate a free session name');

    // Success: hand the temp file off to a delayed cleanup and stop owning it here.
    if (promptFile) { const pf = promptFile; promptFile = null; setTimeout(() => { unlink(pf).catch(() => {}); }, 60000); }
    return { ok: true, session, dir: tildify(dir), mode: modeDef.id, label: modeDef.label, model: modelDef ? modelDef.id : null, command: claudeCmd };
  } finally {
    // Any error before the hand-off leaves promptFile set -> remove it now.
    if (promptFile) unlink(promptFile).catch(() => {});
  }
}

// ---------- transcription ----------
// Dictation: the phone uploads a recorded clip, this machine normalizes it with
// ffmpeg and transcribes it with the `stt` command (../stt, Soniox by default),
// which owns the provider, its key, the language hints and the key terms. This
// server never sees the key, and the phone holds no secret. Nothing is kept: the
// clip lives in a private temp dir only until it is converted, the mp3 reaches stt
// on stdin, the transcript is held in memory until the job expires, and stt deletes
// the provider's copy once the transcript is back.
const TRANSCRIBE_DEFAULTS = {
  maxSeconds: 600,
  maxBytes: 25 * 1024 * 1024,
};
// The override exists for tests. The service's PATH has ~/.local/bin, where
// ../stt/install.sh links the command.
const STT_BIN = process.env.CLAUDE_LAUNCHER_STT || 'stt';
// `stt check` only reads stt's config (about 0.1 s, never the network).
const STT_CHECK_TIMEOUT_MS = 5000;
const STT_CHECK_CACHE_MS = 60 * 1000;
// stt stops waiting for the provider after this, deletes the job and exits 6: the
// phone stops polling at 4 minutes too.
const STT_WAIT_SECONDS = 240;
// The whole stt run, upload included, in case it hangs anyway: SIGTERM first (stt
// deletes the provider job on the way out), then SIGKILL. The override exists for tests.
const STT_BACKSTOP_MS = Number(process.env.CLAUDE_LAUNCHER_STT_BACKSTOP_MS) || 6 * 60 * 1000;
const STT_KILL_GRACE_MS = 3000;
// The JSON transcript of a ten-minute dictation is a few kB.
const STT_MAX_OUTPUT = 1 << 20;
// stt's exit status for a config problem (no key, unknown provider).
const STT_EXIT_CONFIG = 3;
const STT_MISSING = 'stt not found (run ~/development/stt/install.sh)';
const TMP_PREFIX = 'claude-launcher-dictation-';
const MAX_ACTIVE_TRANSCRIPTIONS = 4;
const MAX_STORED_JOBS = 50;
const JOB_TTL_MS = 30 * 60 * 1000;
// Every step below has its own timeout, so this only fires on a bug. It exists
// because a job stuck in "processing" leaves the phone spinning with launch disabled.
const JOB_HARD_LIMIT_MS = 15 * 60 * 1000;
// Under this, ffmpeg recovered a header and no real audio (see ../audiorecorder).
const MIN_AUDIO_SECONDS = 0.5;
// The phone stops itself at maxSeconds, but its final flush runs a little past;
// refusing a ten-minute dictation over half a second of overshoot would be absurd.
const MAX_SECONDS_GRACE = 5;
const FFMPEG_TIMEOUT_MS = 60 * 1000;
// Temp dirs older than this are orphans whatever their pid says (pid reuse).
const TMP_ORPHAN_AGE_MS = 60 * 60 * 1000;

// stt's one-line reason for a failure: its last stderr line starting "stt: "
// (key-free, about 300 characters). The progress lines before it are not for the
// phone, and neither is anything else a crash might print.
function sttMessage(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('stt: ')) return lines[i].slice(0, 300);
  }
  return null;
}

// Only an OK answer is cached, and only for a minute: a broken stt config shows
// on the next /api/config, and fixing it turns the mic back on at once.
let sttCheck = null;
let sttCheckAt = 0;
let sttCheckProbe = null;
function checkStt() {
  if (sttCheck && sttCheck.ok && Date.now() - sttCheckAt < STT_CHECK_CACHE_MS) return Promise.resolve(sttCheck);
  sttCheckProbe ||= probeStt().then((r) => {
    sttCheck = r;
    sttCheckAt = Date.now();
    sttCheckProbe = null;
    return r;
  });
  return sttCheckProbe;
}
// A transcription that found stt missing or its config broken drops the cached OK.
function forgetSttCheck() {
  sttCheck = null;
}
async function probeStt() {
  try {
    await execFileP(STT_BIN, ['check'], { timeout: STT_CHECK_TIMEOUT_MS, maxBuffer: STT_MAX_OUTPUT });
    return { ok: true, reason: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: STT_MISSING };
    if (e.killed) return { ok: false, reason: `stt check timed out after ${STT_CHECK_TIMEOUT_MS / 1000} s` };
    const line = sttMessage(e.stderr);
    if (line) return { ok: false, reason: line.slice('stt: '.length) };
    return { ok: false, reason: typeof e.code === 'number' ? `stt check exited with status ${e.code}` : `stt check failed: ${e.message}` };
  }
}

// Probed once and cached. A failed probe is retried after a minute, so installing
// ffmpeg doesn't need a restart.
let mediaTools = null;
let mediaToolsAt = 0;
let mediaToolsProbe = null;
function checkMediaTools() {
  if (mediaTools && (mediaTools.ok || Date.now() - mediaToolsAt < 60 * 1000)) return Promise.resolve(mediaTools);
  mediaToolsProbe ||= probeMediaTools().then((r) => {
    mediaTools = r;
    mediaToolsAt = Date.now();
    mediaToolsProbe = null;
    return r;
  });
  return mediaToolsProbe;
}
async function probeMediaTools() {
  try {
    await execFileP('ffprobe', ['-version'], { timeout: 5000 });
    const { stdout } = await execFileP('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 5000, maxBuffer: 4 << 20 });
    if (!/\blibmp3lame\b/.test(stdout)) return { ok: false, reason: 'ffmpeg was built without the libmp3lame encoder' };
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? `${e.path} not found (install ffmpeg)` : `ffmpeg check failed: ${e.message}` };
  }
}

// Re-evaluated per request, like config.json: a fixed stt config or a new ffmpeg
// applies to the next dictation without a restart. publicTranscribe() is the only
// view of the result that leaves the process.
// Never throws: a malformed transcription block only turns dictation off, instead
// of failing /api/config — and with it the whole launcher.
async function transcriptionSetup() {
  try {
    return await readTranscriptionSetup();
  } catch (e) {
    return {
      enabled: false,
      reason: `invalid transcription config: ${e.message}`,
      maxSeconds: TRANSCRIBE_DEFAULTS.maxSeconds,
      maxBytes: TRANSCRIBE_DEFAULTS.maxBytes,
    };
  }
}
async function readTranscriptionSetup() {
  // A leftover keyFile from before stt is ignored. "transcription": false would
  // otherwise read as all defaults, dictation on.
  const t = getConfig().transcription ?? {};
  if (typeof t !== 'object' || Array.isArray(t)) throw new Error('"transcription" must be an object');
  const positive = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const setup = {
    enabled: false,
    reason: null,
    maxSeconds: positive(t.maxSeconds, TRANSCRIBE_DEFAULTS.maxSeconds),
    maxBytes: positive(t.maxBytes, TRANSCRIBE_DEFAULTS.maxBytes),
  };
  if (t.enabled === false) {
    setup.reason = 'dictation is disabled in config.json';
    return setup;
  }
  const stt = await checkStt();
  if (!stt.ok) {
    setup.reason = stt.reason;
    return setup;
  }
  const tools = await checkMediaTools();
  if (!tools.ok) {
    setup.reason = tools.reason;
    return setup;
  }
  setup.enabled = true;
  return setup;
}
function publicTranscribe(setup) {
  return { enabled: setup.enabled, reason: setup.reason, maxSeconds: setup.maxSeconds };
}

// Jobs live in memory only. Map insertion order is creation order, which the
// eviction in createJob() relies on.
const jobs = new Map();
// Uploads being received + jobs processing. Counted before the body is read, so a
// burst of uploads can't fill the temp dir before any job exists.
let activeTranscriptions = 0;

function createJob() {
  sweepJobs();
  // Make room by dropping the oldest finished jobs. Processing ones are never
  // evicted; MAX_ACTIVE_TRANSCRIPTIONS already bounds how many there can be.
  for (const [id, job] of jobs) {
    if (jobs.size < MAX_STORED_JOBS) break;
    if (job.status !== 'processing') jobs.delete(id);
  }
  const job = { id: randomUUID(), status: 'processing', createdAt: Date.now(), finishedAt: 0 };
  jobs.set(job.id, job);
  return job;
}
// First writer wins: the runner and the watchdog in sweepJobs() may both try.
function finishJob(job, fields) {
  if (job.status !== 'processing') return;
  Object.assign(job, fields);
  job.finishedAt = Date.now();
}
function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'processing' && now - job.createdAt > JOB_HARD_LIMIT_MS) {
      finishJob(job, { status: 'error', error: 'transcription timed out' });
      console.error(`[transcribe] ${id} watchdog: still processing after ${JOB_HARD_LIMIT_MS / 60000} min`);
    }
    if (job.status !== 'processing' && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}
function jobView(job) {
  const out = { id: job.id, status: job.status };
  if (job.status === 'done') {
    out.text = job.text;
    if (job.language) out.language = job.language;
  }
  if (job.status === 'error') {
    out.error = job.error;
    // false = sending the same clip again would fail the same way, so the phone
    // offers no Retry; `code` lets it word the common case for a person.
    out.retryable = job.retryable !== false;
    if (job.code) out.code = job.code;
  }
  if (job.durationMs != null) out.durationMs = job.durationMs;
  return out;
}

// A crash or restart mid-job skips every finally, and the promise is that no audio
// stays on this PC. The pid in the dir name tells an orphan from a live job of
// another instance sharing the temp dir (a test server, say).
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function sweepOrphanTempDirs() {
  let names;
  try { names = await readdir(os.tmpdir()); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const full = path.join(os.tmpdir(), name);
    let orphan = !processAlive(Number(name.slice(TMP_PREFIX.length).split('-')[0]));
    if (!orphan) {
      try { orphan = Date.now() - (await stat(full)).mtimeMs > TMP_ORPHAN_AGE_MS; } catch { continue; }
    }
    if (orphan) {
      await rm(full, { recursive: true, force: true })
        .then(() => console.log(`[transcribe] removed orphaned temp dir ${name}`), () => {});
    }
  }
}
setInterval(sweepJobs, 60 * 1000).unref();
setInterval(sweepOrphanTempDirs, 10 * 60 * 1000).unref();
sweepOrphanTempDirs();

// The temp dirs of uploads and conversions in progress. A stop (SIGTERM from
// systemd, ^C by hand) skips every finally, and the orphan sweep only runs at the
// next start, so a service left stopped would keep the clip until reboot.
const liveTempDirs = new Set();
// The stt runs in progress. systemd's control-group kill reaches them anyway, but
// a plain `kill` of this process would not: SIGTERM makes stt delete the provider
// job instead of finishing a transcription nobody will read.
const liveSttRuns = new Set();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    for (const dir of liveTempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* the sweep gets it next start */ }
    }
    for (const child of liveSttRuns) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    // The handler was a once(): re-raising exits the way the default action does,
    // so systemd and the shell see the same status as before.
    process.kill(process.pid, signal);
  });
}

// Streams the body into `file` (0600) under a byte cap, so a clip never sits in
// memory and an oversized one is cut off instead of drained. Resolves with the
// byte count; rejects with .aborted when the phone gave up mid-upload.
function receiveUpload(req, file, maxBytes) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const aborted = () => Object.assign(new Error('upload aborted'), { aborted: true, bytes });
    // The client can vanish while the caller awaited (setup, mkdtemp); 'close'
    // has then already fired and would never be seen below.
    if (req.destroyed) { reject(aborted()); return; }
    const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(httpErr(413, `audio is larger than ${maxBytes} bytes`)); return; }
      // Backpressure: a fast link must not outrun the disk and pile up in memory.
      if (!out.write(chunk)) req.pause();
    });
    out.on('drain', () => { if (!settled) req.resume(); });
    req.on('end', () => { if (!settled) out.end(); });
    req.on('error', () => fail(aborted()));
    // 'close' before 'end' = the connection died first. Not req.complete: a body
    // that fully arrived but was still buffered when the socket died never ends.
    req.on('close', () => { if (!req.readableEnded) fail(aborted()); });
    out.on('error', fail);
    out.on('close', () => {
      if (settled || !out.writableFinished) return;
      settled = true;
      resolve(bytes);
    });
  });
}

// Every refusal before the body has been read also closes the connection. Node
// would otherwise read and discard the whole unread body to keep the keep-alive
// socket in sync — exactly the oversized upload the refusal was about.
function refuseUpload(res, status, error) {
  sendJSON(res, status, { error }, { Connection: 'close' });
}

async function handleTranscribeUpload(req, res) {
  // audio/* is not a CORS-safelisted type, so a cross-origin page can't send this
  // without a preflight, and no preflight is ever answered. Same reasoning as the
  // JSON requirement on /api/launch.
  const ct = String(req.headers['content-type'] || '').trim().toLowerCase();
  if (!ct.startsWith('audio/')) return refuseUpload(res, 415, 'content-type must be audio/*');
  const setup = await transcriptionSetup();
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > setup.maxBytes) {
    return refuseUpload(res, 413, `audio is larger than ${setup.maxBytes} bytes`);
  }
  if (declared !== undefined && Number(declared) === 0) return refuseUpload(res, 400, 'empty audio body');
  if (!setup.enabled) return refuseUpload(res, 503, setup.reason);
  if (activeTranscriptions >= MAX_ACTIVE_TRANSCRIPTIONS) {
    return refuseUpload(res, 429, 'too many transcriptions in progress, try again in a moment');
  }

  activeTranscriptions++;
  const startedAt = Date.now();
  let dir = null;
  let handedOff = false;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-`));
    liveTempDirs.add(dir);
    const input = path.join(dir, 'upload');
    const bytes = await receiveUpload(req, input, setup.maxBytes);
    if (!bytes) return refuseUpload(res, 400, 'empty audio body');
    const job = createJob();
    console.log(`[transcribe] ${job.id} received ${bytes} B ${ct.split(';')[0]} in ${Date.now() - startedAt} ms`);
    sendJSON(res, 202, { id: job.id });
    handedOff = true;
    runTranscription(job, { dir, input, bytes, setup, startedAt }); // settles the job on every path
  } catch (e) {
    if (e.aborted) {
      console.log(`[transcribe] upload aborted by the client after ${e.bytes} B`);
      return;
    }
    // The rest of an oversized body is never read: drop the socket once the 413 is out.
    if (e.status === 413) res.once('finish', () => req.destroy());
    if (!e.status) console.error('[transcribe] storing the upload failed', e);
    return refuseUpload(res, e.status || 500, e.message || 'upload failed');
  } finally {
    if (!handedOff) {
      activeTranscriptions--;
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch((e) => console.error('[transcribe] temp cleanup failed', e));
        liveTempDirs.delete(dir);
      }
    }
  }
}

async function runTranscription(job, { dir, input, bytes, setup, startedAt }) {
  const tag = `[transcribe] ${job.id}`;
  try {
    const t0 = Date.now();
    const mp3 = path.join(dir, 'speech.mp3');
    const seconds = await normalizeAudio(input, mp3, setup.maxSeconds, tag);
    job.durationMs = Math.round(seconds * 1000);
    const ffmpegMs = Date.now() - t0;
    // ~3.6 MB for ten minutes at 48 kbit/s. Holding it in memory lets the local
    // copy go before the network phase, however long that ends up taking: stt
    // reads it from stdin and keeps it in memory too.
    const audio = await readFile(mp3);
    await rm(dir, { recursive: true, force: true });
    const r = await transcribeWithStt(audio, tag);
    finishJob(job, { status: 'done', text: r.text, language: r.language });
    // Never the text: the journal is not where a dictated prompt should end up.
    console.log(`${tag} done: ${bytes} B in, ${seconds.toFixed(1)} s audio, language ${r.language || '?'}`
      + `${r.text ? '' : ' (no speech)'}, ${r.provider || 'provider ?'}; ffmpeg ${ffmpegMs} ms,`
      + ` stt ${r.sttMs} ms, total ${Date.now() - startedAt} ms`);
  } catch (e) {
    finishJob(job, {
      status: 'error',
      error: e.message || 'transcription failed',
      retryable: !e.permanent,
      code: e.permanent || undefined,
    });
    console.log(`${tag} error after ${Date.now() - startedAt} ms (${bytes} B in): ${e.message}`);
  } finally {
    activeTranscriptions--;
    await rm(dir, { recursive: true, force: true }).catch((e) => console.error(`${tag} temp cleanup failed`, e));
    liveTempDirs.delete(dir);
  }
}

// Errors that sending the same clip again would only repeat. `permanent` doubles
// as the code the phone words its message by.
function permanentError(message, code) {
  return Object.assign(new Error(message), { permanent: code });
}

// One ffmpeg run with the flags ../audiorecorder/pwa/pipeline.py measured:
// +discardcorrupt drops a truncated final AAC frame, aresample=async turns a gap
// into silence instead of silently collapsing it. Mono 16 kHz is all speech needs
// and keeps the upload small. -t bounds the work a runaway upload can cause.
async function normalizeAudio(input, output, maxSeconds, tag) {
  // Pre-created so the output is 0600 too: -y truncates it in place.
  await writeFile(output, '', { mode: 0o600, flag: 'wx' });
  const args = [
    '-nostdin', '-hide_banner', '-v', 'error', '-y',
    '-fflags', '+discardcorrupt',
    // Only the containers a browser records. Left to probe, ffmpeg also accepts
    // playlists: an uploaded DASH manifest would make it open and decode any local
    // file it names. Each entry matches all its demuxer's aliases (mov = mp4/m4a,
    // matroska = webm).
    '-format_whitelist', 'mov,matroska,ogg,wav,aac,mp3',
    '-i', input,
    '-map', '0:a:0', '-vn',
    '-af', 'aresample=async=1:first_pts=0',
    '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-b:a', '48k',
    '-t', String(maxSeconds + MAX_SECONDS_GRACE + 1),
    output,
  ];
  let ffmpegError = '';
  try {
    await execFileP('ffmpeg', args, { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1 << 20 });
  } catch (e) {
    if (e.killed) throw new Error('audio conversion timed out');
    // Killed for logging past maxBuffer (then e.killed is unset), or by a signal
    // from outside: the mp3 stops wherever ffmpeg was, and would pass as a shorter
    // dictation. The flood comes from the clip itself, so a retry would repeat it.
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw permanentError('audio conversion failed', 'conversion');
    if (e.signal) throw new Error('audio conversion failed');
    // Not fatal by itself: a truncated clip can fail late and still hold audio.
    ffmpegError = String(e.stderr || e.message)
      .split(input).join('upload')
      .replace(/\[[^\]]* @ 0x[0-9a-f]+\]\s*/g, '') // "[in#0 @ 0x55f6…]" context prefixes
      .replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  // Neither the exit code nor the file size proves anything: a clip holding only
  // an init segment exits 0 and writes a valid, empty mp3. On mp3 the container
  // duration equals the decoded audio, so it is the one cheap check to trust.
  const seconds = await probeDuration(output);
  if (!seconds || seconds < MIN_AUDIO_SECONDS) {
    throw permanentError('no audio captured' + (ffmpegError ? ` (ffmpeg: ${ffmpegError})` : ''), 'no_audio');
  }
  if (seconds > maxSeconds + MAX_SECONDS_GRACE) {
    throw permanentError(`recording is longer than the ${fmtClock(maxSeconds)} limit`, 'too_long');
  }
  if (ffmpegError) console.log(`${tag} ffmpeg complained but ${seconds.toFixed(1)} s decoded: ${ffmpegError}`);
  return seconds;
}
async function probeDuration(file) {
  try {
    const { stdout } = await execFileP('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 15000 });
    const s = parseFloat(stdout);
    return Number.isFinite(s) ? s : null;
  } catch { return null; }
}
function fmtClock(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// stt's --json transcript as the job keeps it, or null for anything else.
function readTranscript(s, t0) {
  let j = null;
  try { j = JSON.parse(s); } catch { return null; }
  if (!j || typeof j !== 'object' || typeof j.text !== 'string') return null;
  const first = Array.isArray(j.utterances) ? j.utterances[0] : null;
  return {
    // An empty text is silence: "no speech detected" on the phone.
    text: j.text.trim(),
    // Display and log only. With --no-speakers there is one utterance.
    language: first && typeof first.language === 'string' ? first.language : null,
    provider: typeof j.provider === 'string' ? j.provider : null,
    sttMs: Date.now() - t0,
  };
}

// One `stt transcribe` per dictation, with the mp3 on stdin. stt takes the provider,
// key, language hints and key terms from its own config, retries a failed submit,
// waits out a minute of failing status checks, and deletes the provider's copy on
// every outcome. Its exit status says what kind of failure it was (../stt/README.md);
// only a config problem is permanent, since anything else past ffmpeg may pass on a
// retry. stdout carries the transcript, so it is never logged.
function transcribeWithStt(audio, tag) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const args = ['transcribe', '--json', '--no-speakers', '--timeout', String(STT_WAIT_SECONDS), '-'];
    const child = spawn(STT_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    liveSttRuns.add(child);
    const out = { stdout: [], stderr: [], bytes: 0 };
    let overflow = false;
    let timedOut = false;
    let killTimer = null;
    let settled = false;
    // stdout's first line has been looked at; delivered = it was the transcript.
    let lineRead = false;
    let delivered = false;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ||= setTimeout(() => child.kill('SIGKILL'), STT_KILL_GRACE_MS);
    };
    // Runs until stt exits, so it also bounds the cleanup after the transcript.
    const backstop = setTimeout(() => {
      timedOut = true;
      console.log(`${tag} stt still running after ${Math.round(STT_BACKSTOP_MS / 1000)} s`
        + `${delivered ? ', past its transcript' : ''}; stopping it`);
      stop();
    }, STT_BACKSTOP_MS);
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    const collect = (name) => (chunk) => {
      if (overflow) return;
      out.bytes += chunk.length;
      if (out.bytes > STT_MAX_OUTPUT) {
        overflow = true;
        stop();
        return;
      }
      out[name].push(chunk);
    };
    child.stdout.on('data', (chunk) => {
      collect('stdout')(chunk);
      // stt writes the transcript as one line, then deletes the provider's copy.
      // Taken from that line, it reaches the phone without waiting on the cleanup,
      // and a backstop that cuts the cleanup short cannot lose it.
      if (settled || lineRead || overflow || !chunk.includes(0x0a)) return;
      lineRead = true;
      const s = Buffer.concat(out.stdout).toString('utf8');
      const r = readTranscript(s.slice(0, s.indexOf('\n')), t0);
      if (!r) return;
      delivered = true;
      settle(null, r);
    });
    child.stderr.on('data', collect('stderr'));
    // Not started at all, so nothing reached a provider.
    child.on('error', (e) => {
      if (e.code !== 'ENOENT') return settle(new Error(`could not run stt: ${e.message}`));
      forgetSttCheck();
      settle(permanentError(STT_MISSING, 'config'));
    });
    // stt exits without reading stdin on a config problem; its exit status says so.
    child.stdin.on('error', () => {});
    child.stdin.end(audio);
    // Also after a spawn 'error': Node closes the pipes of a child that never started.
    child.on('close', (code, signal) => {
      clearTimeout(backstop);
      clearTimeout(killTimer);
      liveSttRuns.delete(child);
      const how = signal ? `stt was killed by ${signal}` : `stt exited with status ${code}`;
      const line = code === 0 ? null : sttMessage(Buffer.concat(out.stderr).toString('utf8'));
      if (delivered) {
        // The job has its transcript; only the cleanup can have gone wrong.
        if (code !== 0) console.log(`${tag} ${how} after its transcript${line ? `: ${line}` : ''}`);
        return;
      }
      if (timedOut) return settle(new Error('transcription timed out'));
      if (overflow) return settle(new Error(`stt printed more than ${STT_MAX_OUTPUT >> 20} MB`));
      if (code !== 0) {
        if (code !== STT_EXIT_CONFIG) return settle(new Error(line || how));
        forgetSttCheck();
        return settle(permanentError(line || how, 'config'));
      }
      // A transcript without its newline was not taken above.
      const r = readTranscript(Buffer.concat(out.stdout).toString('utf8'), t0);
      settle(r ? null : new Error('stt answered with something other than a JSON transcript'), r);
    });
  });
}

// ---------- static files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC, rel));
  // Separator-aware confinement: forbid siblings like `<...>/public-secret`.
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(full);
    const type = TYPES[path.extname(full)] || 'application/octet-stream';
    const headers = { 'Content-Type': type };
    if (rel === '/sw.js') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

// ---------- request plumbing ----------
function sendJSON(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; fn(arg); };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > 1 << 20) { finish(reject, httpErr(413, 'body too large')); return; }
      data += c;
    });
    req.on('end', () => finish(resolve, data));
    req.on('error', (e) => finish(reject, e));
  });
}
function checkToken(req, url) {
  const token = getConfig().token;
  if (!token) return true;
  const provided = req.headers['x-launcher-token'] || url.searchParams.get('token');
  return provided === token;
}
// Defense-in-depth against drive-by requests from other pages in a local browser
// (the server binds loopback, which every local tab can reach regardless of tailnet).
function browserGuard(req) {
  // Sec-Fetch-Site is set by browsers and not forgeable from JS. Same-origin PWA
  // calls send 'same-origin'; non-browser clients (curl, health check) omit it.
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  // Host allowlist also closes DNS-rebinding. Empty/absent list = skip.
  const allowed = getConfig().allowedHosts;
  if (allowed && allowed.length) {
    let host = '';
    try { host = new URL('http://' + (req.headers.host || '')).hostname.toLowerCase(); } catch { return false; }
    if (!allowed.map((s) => s.toLowerCase()).includes(host)) return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (!browserGuard(req)) return sendJSON(res, 403, { error: 'request blocked' });
      if (!checkToken(req, url)) return sendJSON(res, 401, { error: 'unauthorized' });

      if (p === '/api/health') return sendJSON(res, 200, { ok: true });
      if (p === '/api/config' && req.method === 'GET') {
        const cfg = getConfig();
        // The launcher must not depend on dictation: a broken transcription block
        // only turns the mic off.
        const transcribe = publicTranscribe(await transcriptionSetup());
        return sendJSON(res, 200, {
          modes: (cfg.modes || []).map((m) => ({ id: m.id, label: m.label, subtitle: m.subtitle || '' })),
          models: models().map((m) => ({ id: m.id, label: m.label })),
          favorites: favorites().map((f) => ({ path: tildify(f.path), label: f.label })),
          home: '~',
          transcribe,
        });
      }
      if (p === '/api/dirs' && req.method === 'GET') {
        return sendJSON(res, 200, { dirs: await searchDirs(url.searchParams.get('q') || '') });
      }
      if (p === '/api/browse' && req.method === 'GET') {
        return sendJSON(res, 200, await browse(url.searchParams.get('path') || ''));
      }
      if (p === '/api/sessions' && req.method === 'GET') {
        return sendJSON(res, 200, { sessions: await listSessions() });
      }
      if (p === '/api/launch' && req.method === 'POST') {
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (!ct.startsWith('application/json')) return sendJSON(res, 415, { error: 'content-type must be application/json' });
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { throw httpErr(400, 'invalid JSON body'); }
        return sendJSON(res, 200, await launch(body));
      }
      if (p === '/api/transcribe' && req.method === 'POST') return await handleTranscribeUpload(req, res);
      if (p.startsWith('/api/transcribe/') && req.method === 'GET') {
        sweepJobs();
        const job = jobs.get(p.slice('/api/transcribe/'.length));
        if (!job) return sendJSON(res, 404, { error: 'unknown or expired transcription' });
        // It carries the transcript: keep it out of every HTTP cache.
        return sendJSON(res, 200, jobView(job), { 'Cache-Control': 'no-store' });
      }
      return sendJSON(res, 404, { error: 'unknown endpoint' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
    return serveStatic(res, p);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[error]', e);
    return sendJSON(res, status, { error: e.message || 'server error' });
  }
});

// Never let a stray rejection take down the systemd service.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

server.listen(PORT, HOST, () => {
  console.log(`claude-launcher listening on http://${HOST}:${PORT}`);
});
