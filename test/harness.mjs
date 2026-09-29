// Shared plumbing for the dictation tests: a stub AssemblyAI, the real server.mjs
// on a free port with its own config and temp dir, and audio made at test time.
//
// Nothing here touches the live service (port 8838), the project's config.json
// or the real AssemblyAI key file: every server gets a throwaway config, a fake
// key file and ASSEMBLYAI_BASE_URL pointing at the stub.
import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_PORT = 8838;
// Must match TMP_PREFIX in server.mjs: the tests assert no such dir outlives a job.
export const TMP_PREFIX = 'claude-launcher-dictation-';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- small helpers ----------
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Polls `fn` until it returns something truthy; the last value is returned so a
// failing assert afterwards shows what was actually seen.
export async function waitFor(fn, { timeout = 5000, interval = 50 } = {}) {
  const until = Date.now() + timeout;
  let v;
  for (;;) {
    v = await fn();
    if (v || Date.now() > until) return v;
    await sleep(interval);
  }
}

export async function missingTools(tools = ['espeak-ng', 'ffmpeg', 'ffprobe']) {
  const missing = [];
  for (const cmd of tools) {
    // ffmpeg/ffprobe spell it -version, espeak-ng --version.
    try { await execFileP(cmd, [cmd.startsWith('ff') ? '-version' : '--version'], { timeout: 5000 }); }
    catch (e) { if (e.code === 'ENOENT') missing.push(cmd); } // any other failure: present
  }
  return missing;
}

// ---------- audio fixtures ----------
const FRAGMENTED_MP4 = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4'];
async function ffmpeg(args) {
  await execFileP('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args], { timeout: 60000 });
}

export async function probeAudio(file) {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-print_format', 'json',
    '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', file], { timeout: 15000 });
  const j = JSON.parse(stdout);
  const s = (j.streams || [])[0] || {};
  return { codec: s.codec_name, sampleRate: Number(s.sample_rate), channels: s.channels, duration: Number(j.format && j.format.duration) };
}

// Speech from espeak-ng, then two containers browsers upload: fragmented MP4/AAC
// as iOS Safari's MediaRecorder writes it (init segment, then one moof+mdat per
// timeslice) and WebM/Opus as Firefox and older Chrome write it (current Chrome
// records Opus in MP4; test/browser.mjs covers that one).
export async function makeClips(dir, sentence = 'Refactor the upload handler and add a test for the empty body case.') {
  const c = {
    wav: path.join(dir, 'speech.wav'),
    mp4: path.join(dir, 'speech.mp4'),
    webm: path.join(dir, 'speech.webm'),
    short: path.join(dir, 'short.mp4'),
    long: path.join(dir, 'long.mp4'),
  };
  await execFileP('espeak-ng', ['-v', 'en-us', '-s', '150', '-w', c.wav, sentence], { timeout: 30000 });
  await ffmpeg(['-i', c.wav, '-c:a', 'aac', '-b:a', '64k', ...FRAGMENTED_MP4, c.mp4]);
  await ffmpeg(['-i', c.wav, '-c:a', 'libopus', '-b:a', '32k', c.webm]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-c:a', 'aac', ...FRAGMENTED_MP4, c.short]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'aac', '-b:a', '32k', ...FRAGMENTED_MP4, c.long]);
  c.speechSeconds = (await probeAudio(c.wav)).duration;
  return c;
}

// ---------- stub AssemblyAI ----------
// Implements the four routes server.mjs uses and records everything it is sent.
// Behaviour is scripted per test through these queues, each entry consumed by the
// next matching request:
//   uploadFailures  [{ status, body }]                 next POST /v2/upload fails
//   submitFailures  [{ status, body, onlyWithKeyterms }] next POST /v2/transcript fails
//   pollFailures    [{ status, body } | { reset }]      next GET /v2/transcript/<id> fails
//   deleteFailures  [{ status, body } | { reset }]      next DELETE /v2/transcript/<id> fails
//   outcomes        [{ error } | { hold } | { pollsBeforeDone, text, language }]
//                   applied to the next transcript created
// { reset: true } drops the connection without an answer, like a network blip.
// A held transcript reports "processing" until release().
export async function startAssemblyAIStub({ text, language = 'en' } = {}) {
  let seq = 0;
  const stub = {
    text,
    language,
    requests: [],
    uploads: [],
    submits: [],
    deletes: [],
    transcripts: new Map(),
    uploadFailures: [],
    submitFailures: [],
    pollFailures: [],
    deleteFailures: [],
    outcomes: [],
    url: '',
    reset() {
      for (const k of ['requests', 'uploads', 'submits', 'deletes', 'uploadFailures', 'submitFailures',
        'pollFailures', 'deleteFailures', 'outcomes']) stub[k] = [];
      stub.transcripts.clear();
    },
    release() {
      for (const t of stub.transcripts.values()) t.hold = false;
    },
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://stub');
    const auth = req.headers.authorization;
    stub.requests.push({ method: req.method, path: url.pathname, auth });
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    const fail = (f) => (f.reset ? req.socket.destroy() : send(f.status, f.body));
    if (!auth) return send(401, { error: 'Authentication error, API token missing/invalid' });

    if (req.method === 'POST' && url.pathname === '/v2/upload') {
      stub.uploads.push({ auth, contentType: req.headers['content-type'], body });
      const f = stub.uploadFailures.shift();
      if (f) return send(f.status, f.body);
      return send(200, { upload_url: `https://cdn.stub.invalid/upload/${stub.uploads.length}` });
    }
    if (req.method === 'POST' && url.pathname === '/v2/transcript') {
      let json;
      try { json = JSON.parse(body.toString('utf8')); } catch { return send(400, { error: 'json data invalid' }); }
      stub.submits.push({ auth, contentType: req.headers['content-type'], json });
      const f = stub.submitFailures[0];
      if (f && (!f.onlyWithKeyterms || json.keyterms_prompt)) {
        stub.submitFailures.shift();
        return send(f.status, f.body);
      }
      const id = `tr_${++seq}`;
      stub.transcripts.set(id, { id, polls: 0, status: 'processing', ...(stub.outcomes.shift() || {}) });
      return send(200, { id, status: 'queued' });
    }
    const m = /^\/v2\/transcript\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const t = stub.transcripts.get(decodeURIComponent(m[1]));
      if (!t) return send(400, { error: 'Transcript lookup error, transcript id not found' });
      if (req.method === 'DELETE') {
        const f = stub.deleteFailures.shift();
        if (f) return fail(f);
        // Like the real API: a transcript still processing can't be deleted.
        if (t.status === 'processing') return send(400, { error: 'Transcript lookup error, transcript id not found' });
        stub.deletes.push(t.id);
        return send(200, { id: t.id, status: t.status, text: 'Deleted by user.' });
      }
      if (req.method === 'GET') {
        const f = stub.pollFailures.shift();
        if (f) return fail(f);
        t.polls++;
        if (t.hold || t.polls <= (t.pollsBeforeDone || 0)) return send(200, { id: t.id, status: 'processing' });
        if (t.error) {
          t.status = 'error';
          return send(200, { id: t.id, status: 'error', error: t.error, text: null });
        }
        t.status = 'completed';
        return send(200, {
          id: t.id,
          status: 'completed',
          text: t.text ?? stub.text,
          language_code: t.language ?? stub.language,
          speech_model_used: 'universal-3-5-pro',
        });
      }
    }
    return send(404, { error: `stub: no route ${req.method} ${url.pathname}` });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return stub;
}

// ---------- the real server ----------
// A config close to the shipped one. allowedRoots is always replaced by the
// server's own scratch dir in startServer(): even a launch request that slipped
// through could not reach a real directory (the page defaults to "~").
export function baseConfig({ keyFile, transcription = {} }) {
  return {
    host: '127.0.0.1',
    token: null,
    remoteControl: true,
    allowedHosts: ['127.0.0.1', 'localhost'],
    transcription: { enabled: true, keyFile, maxSeconds: 600, maxBytes: 26214400, ...transcription },
    models: [{ id: 'opus', label: 'Opus' }, { id: 'fable', label: 'Fable' }],
    modes: [
      { id: 'normal', label: 'Claude', subtitle: 'standard session', args: [] },
      { id: 'ultracode', label: 'Ultracode', subtitle: 'xhigh + workflow orchestration', args: ['--settings', '{"ultracode":true}'] },
    ],
    favorites: [],
  };
}

// A test that dies on an uncaught exception skips its cleanup; this still takes
// the servers it spawned down with it instead of leaving them listening.
const liveServers = new Map(); // process -> its scratch dir
process.on('exit', () => {
  for (const [p, dir] of liveServers) {
    p.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

// Spawns server.mjs with its own config file and TMPDIR (so its dictation temp
// dirs can be counted exactly, and never mix with the live service's). Any
// ASSEMBLYAI_* variable in the caller's environment is dropped; pass `env` to set one.
export async function startServer({ config, env = {} }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-launcher-test-'));
  const tmp = path.join(dir, 'tmp');
  await mkdir(tmp, { mode: 0o700 });
  const configPath = path.join(dir, 'config.json');
  const port = await freePort();
  if (port === LIVE_PORT) throw new Error('refusing to use the live port');
  const writeConfig = (cfg) => writeFile(configPath, JSON.stringify({ ...cfg, allowedRoots: [dir] }, null, 2));
  await writeConfig(config);

  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith('ASSEMBLYAI_')) delete childEnv[k];
  Object.assign(childEnv, { PORT: String(port), HOST: '127.0.0.1', CLAUDE_LAUNCHER_CONFIG: configPath, TMPDIR: tmp }, env);
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  liveServers.set(proc, dir);
  proc.once('exit', () => liveServers.delete(proc));
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + log)), 10000);
    const onData = () => { if (log.includes('listening on')) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${log}`)); });
  });

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    dir,
    tmp,
    configPath,
    proc,
    get log() { return log; },
    writeConfig,
    // Names of the dictation temp dirs that currently exist for this server.
    async tempDirs() {
      return (await readdir(tmp)).filter((n) => n.startsWith(TMP_PREFIX));
    },
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
        await once(proc, 'exit');
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// POSTs a clip the way the PWA does and returns status, parsed JSON and headers.
export async function upload(base, body, { type = 'audio/mp4', headers = {} } = {}) {
  const h = { ...headers };
  if (type !== null) h['Content-Type'] = type;
  const r = await fetch(base + '/api/transcribe', { method: 'POST', headers: h, body });
  const json = await r.json().catch(() => null);
  return { status: r.status, json, headers: r.headers };
}

export async function waitJob(base, id, timeout = 30000) {
  const until = Date.now() + timeout;
  for (;;) {
    const r = await fetch(`${base}/api/transcribe/${id}`);
    const j = await r.json();
    if (r.status !== 200 || j.status !== 'processing') return { httpStatus: r.status, cacheControl: r.headers.get('cache-control'), ...j };
    if (Date.now() > until) throw new Error(`job ${id} still processing after ${timeout} ms`);
    await sleep(150);
  }
}
