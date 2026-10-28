// Shared plumbing for the dictation tests: a stand-in `stt` command, the real
// server.mjs on a free port with its own config and temp dir, and audio made at
// test time.
//
// Nothing here touches the live service (port 8838), the project's config.json,
// stt's config or a provider: every server gets a throwaway config, its own
// TMPDIR, and an STT_CONFIG that does not exist, so even the real stt reached by
// mistake stops at "no key" before any network.
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

// ---------- a stand-in stt ----------
// A fake `stt` executable (point CLAUDE_LAUNCHER_STT at stub.bin, as stub.env does)
// that asks a loopback stub in the test process what to do. The stub records
// every call and answers from a queue scripted per test:
//   stub.check      { exit, message }   what `stt check` does (default: exit 0)
//   stub.outcomes   applied to the next `stt transcribe`, in order:
//     { text, language }      exit 0 with a --json transcript (stub.text/.language by default;
//                             an empty text has no utterances, like silence)
//     { exit, message }       progress noise, then "stt: <message>" as the last stderr line
//     { exit, stderr }        exactly this stderr (a crash without stt's own last line)
//     { raw }                 exit 0 with exactly this on stdout
//     { hang, ignoreTerm }    never finishes; on SIGTERM it exits 143 like stt, unless ignoreTerm
//     { hold: true, ... }     waits for release() first
//     { cleanup: 'hold' }     the transcript, then stt's deletion of the provider copy waits
//                             for release() before it exits 0
//     { cleanup: 'hang' }     the transcript, then a deletion that never ends; on SIGTERM it
//                             exits 143 the way stt does once its transcript is out
// Each call is { argv, audio, pid, tempDirs }: tempDirs are the dictation temp dirs
// that existed in the server's TMPDIR while stt ran.
const FAKE_STT = `#!${process.execPath}
// The stand-in stt of test/harness.mjs. No import statements: Node runs it as
// either module type.
(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const argv = process.argv.slice(2);
  let ignoreTerm = false;
  let delivered = false;
  process.on('SIGTERM', () => {
    if (ignoreTerm) return;
    process.stderr.write(delivered ? 'stt: SIGTERM arrived after the transcript was written\\n' : 'stt: cancelled by SIGTERM\\n');
    process.exit(143);
  });
  const hang = () => {
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(1), 60000).unref(); // never outlive a test run by much
  };
  process.stdout.on('error', () => process.exit(1)); // the reader went away
  const chunks = [];
  if (argv[0] === 'transcribe' && argv[argv.length - 1] === '-') for await (const c of process.stdin) chunks.push(c);
  const tempDirs = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(${JSON.stringify(TMP_PREFIX)}));
  let r;
  try {
    const res = await fetch(process.env.FAKE_STT_URL + '/' + argv[0], {
      method: 'POST',
      body: JSON.stringify({ argv, pid: process.pid, tempDirs, audio: Buffer.concat(chunks).toString('base64') }),
    });
    r = await res.json();
  } catch (e) {
    process.stderr.write('stt: fake stt: the test stub is gone (' + e.message + ')\\n');
    process.exit(1);
  }
  if (r.hang) {
    ignoreTerm = !!r.ignoreTerm;
    return hang();
  }
  const write = (stream, s) => new Promise((resolve) => (s ? stream.write(s, resolve) : resolve()));
  await write(process.stderr, r.stderr);
  await write(process.stdout, r.stdout);
  if (r.cleanup) {
    // The transcript is out; what follows stands for stt deleting the provider's copy.
    delivered = true;
    if (r.cleanup === 'hang') return hang();
    await fetch(process.env.FAKE_STT_URL + '/cleanup', { method: 'POST', body: '{}' }).catch(() => {});
  }
  process.exitCode = r.exit;
})();
`;

export async function startSttStub({ text, language = 'en' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-launcher-fake-stt-'));
  const bin = path.join(dir, 'stt');
  await writeFile(bin, FAKE_STT, { mode: 0o755 });
  const held = [];
  const stub = {
    text,
    language,
    bin,
    check: { exit: 0 },
    checks: [],
    calls: [],
    outcomes: [],
    url: '',
    // What startServer() needs to run this stub's stt.
    get env() { return { CLAUDE_LAUNCHER_STT: bin, FAKE_STT_URL: stub.url }; },
    reset() {
      stub.check = { exit: 0 };
      stub.checks = [];
      stub.calls = [];
      stub.outcomes = [];
    },
    release() {
      for (const resume of held.splice(0)) resume();
    },
  };
  const progress = 'Uploading audio to the stub...\nTranscribing with stub...\n';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const send = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/check') {
      stub.checks.push(call.argv);
      const c = stub.check;
      return send(c.exit ? { exit: c.exit, stdout: 'provider: stub\n', stderr: `stt: ${c.message}\n` } : { exit: 0, stdout: 'provider: stub\n' });
    }
    if (req.url === '/cleanup') {
      await new Promise((resolve) => held.push(resolve));
      return send({});
    }
    if (req.url !== '/transcribe') return send({ exit: 2, stderr: `stt: stub: no command ${req.url}\n` });
    stub.calls.push({ argv: call.argv, audio: Buffer.from(call.audio, 'base64'), pid: call.pid, tempDirs: call.tempDirs });
    const o = stub.outcomes.shift() || {};
    if (o.hold) await new Promise((resolve) => held.push(resolve));
    if (o.hang) return send({ hang: true, ignoreTerm: !!o.ignoreTerm });
    if (o.raw !== undefined) return send({ exit: 0, stdout: o.raw });
    if (o.exit !== undefined) return send({ exit: o.exit, stderr: o.stderr ?? `${progress}stt: ${o.message}\n` });
    const t = o.text ?? stub.text;
    const utterances = t.trim() ? [{ text: t, speaker: null, start_ms: 0, end_ms: 1000, language: o.language ?? stub.language }] : [];
    return send({
      exit: 0,
      stdout: JSON.stringify({ provider: 'stub', text: t, utterances }) + '\n',
      stderr: `${progress}Transcription done.\n`,
      cleanup: o.cleanup,
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = async () => {
    stub.release();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  };
  return stub;
}

// The real stt command, for the tests that run it with the fake provider; null
// when it is not installed.
export async function realStt() {
  try { return (await execFileP('sh', ['-c', 'command -v stt'])).stdout.trim() || null; } catch { return null; }
}

// ---------- the real server ----------
// A config close to the shipped one. allowedRoots is always replaced by the
// server's own scratch dir in startServer(): even a launch request that slipped
// through could not reach a real directory (the page defaults to "~").
export function baseConfig({ transcription = {} } = {}) {
  return {
    host: '127.0.0.1',
    token: null,
    remoteControl: true,
    allowedHosts: ['127.0.0.1', 'localhost'],
    transcription: { enabled: true, maxSeconds: 600, maxBytes: 26214400, ...transcription },
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
// dirs can be counted exactly, and never mix with the live service's). The
// caller's STT_*, CLAUDE_LAUNCHER_*, FAKE_STT_* and ASSEMBLYAI_* variables are
// dropped, and STT_CONFIG names a file that does not exist; pass `env` (say
// stub.env) to set them.
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
  for (const k of Object.keys(childEnv)) if (/^(STT_|CLAUDE_LAUNCHER_|FAKE_STT_|ASSEMBLYAI_)/.test(k)) delete childEnv[k];
  Object.assign(childEnv, {
    PORT: String(port),
    HOST: '127.0.0.1',
    CLAUDE_LAUNCHER_CONFIG: configPath,
    TMPDIR: tmp,
    STT_CONFIG: path.join(dir, 'no-stt-config'),
  }, env);
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
