// The dictation API end to end: the real server.mjs, real ffmpeg, and a stand-in
// stt command (see harness.mjs), plus one case through the real stt with its fake
// provider. Run with:  node --test test/transcribe.test.mjs
//
// Two servers share the stand-in: A has the shipped limits, B small maxBytes and
// maxSeconds for the limit cases. Neither touches the live service, its
// config.json, stt's config or a provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  UUID_RE, missingTools, makeClips, probeAudio, startSttStub, realStt, startServer,
  baseConfig, upload, waitJob, waitFor,
} from './harness.mjs';

// Padded on purpose: the server must hand the phone trimmed text.
const STUB_TEXT = '  Refactor the upload handler and add a test.  ';
const SMALL_MAX_BYTES = 200_000;
const SMALL_MAX_SECONDS = 2;
// What server.mjs must run: the mp3 on stdin, the phone's 4-minute deadline.
const STT_ARGS = ['transcribe', '--json', '--no-speakers', '--timeout', '240', '-'];

const execFileP = promisify(execFile);
const missing = await missingTools();
// Everything that needs a clip or an enabled server (which itself needs ffmpeg).
const needsAudio = missing.length ? `needs ${missing.join(', ')}` : false;
const REAL_STT = await realStt();

let work;
let clips;
let stub;
let A;
let B;
let victim; // a local audio file the DASH case must not be able to reach

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'claude-launcher-test-work-'));
  stub = await startSttStub({ text: STUB_TEXT, language: 'en' });
  if (!needsAudio) {
    clips = await makeClips(work);
    victim = path.join(work, 'victim.m4a');
    await execFileP('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', clips.wav, '-c:a', 'aac', victim], { timeout: 30000 });
  }
  A = await startServer({ config: baseConfig(), env: stub.env });
  B = await startServer({
    config: baseConfig({ transcription: { maxBytes: SMALL_MAX_BYTES, maxSeconds: SMALL_MAX_SECONDS } }),
    env: stub.env,
  });
});

after(async () => {
  await Promise.all([A && A.stop(), B && B.stop()]);
  if (stub) await stub.close();
  if (work) await rm(work, { recursive: true, force: true });
});

// The promise is that no audio outlives its job. Cleanup runs right after the
// job settles, so give it a moment rather than racing it.
async function assertNoTempDirs(server) {
  const left = await waitFor(async () => (await server.tempDirs()).length === 0, { timeout: 3000 });
  assert.ok(left, `temp dirs left behind: ${(await server.tempDirs()).join(', ')}`);
}

async function transcribe(server, file, type = 'audio/mp4') {
  const r = await upload(server.base, await readFile(file), { type });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.match(r.json.id, UUID_RE);
  return waitJob(server.base, r.json.id);
}

async function transcribeConfig(server) {
  return (await (await fetch(server.base + '/api/config')).json()).transcribe;
}

function processGone(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

// Raw TCP, for what fetch hides: whether the server hangs up on an unread body.
// Resolves once the server closes the socket, with everything it sent.
function rawSocket(port) {
  const sock = net.connect(port, '127.0.0.1');
  const s = { sock, data: '', closed: false };
  sock.on('data', (d) => { s.data += d; });
  sock.on('error', () => {}); // a reset after the refusal is the server doing its job
  s.closedP = new Promise((resolve) => sock.on('close', () => { s.closed = true; resolve(); }));
  s.connected = once(sock, 'connect');
  return s;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]);

// ---------- availability ----------

test('GET /api/config reports dictation available, with maxSeconds from config', { skip: needsAudio }, async () => {
  stub.reset();
  assert.deepEqual(await transcribeConfig(A), { enabled: true, reason: null, maxSeconds: 600 });
  assert.deepEqual(await transcribeConfig(B), { enabled: true, reason: null, maxSeconds: SMALL_MAX_SECONDS });
  assert.deepEqual(stub.checks, [['check'], ['check']], 'each server asks `stt check`');
});

test('stt check failing disables dictation with its message, re-evaluated without a restart', { skip: needsAudio }, async () => {
  stub.reset();
  const problem = 'soniox_api_key is not set in /home/someone/.config/stt/config';
  stub.check = { exit: 3, message: problem };
  const D = await startServer({ config: baseConfig(), env: stub.env });
  try {
    const t = await transcribeConfig(D);
    assert.deepEqual(t, { enabled: false, reason: problem, maxSeconds: 600 });
    const r = await upload(D.base, await readFile(clips.mp4));
    assert.equal(r.status, 503);
    assert.equal(r.json.error, problem);
    assert.equal(r.headers.get('connection'), 'close');

    stub.check = { exit: 0 };
    assert.equal((await transcribeConfig(D)).enabled, true, 'fixing stt\'s config re-enables dictation without a restart');

    await D.writeConfig(baseConfig({ transcription: { enabled: false } }));
    const off = await transcribeConfig(D);
    assert.equal(off.enabled, false);
    assert.match(off.reason, /disabled/);
  } finally {
    await D.stop();
  }
  assert.equal(stub.calls.length, 0, 'nothing may be transcribed while disabled');
});

test('stt not installed disables dictation and says how to install it', async () => {
  const E = await startServer({ config: baseConfig(), env: { ...stub.env, CLAUDE_LAUNCHER_STT: path.join(work, 'no-such-stt') } });
  try {
    const t = await transcribeConfig(E);
    assert.deepEqual(t, { enabled: false, reason: 'stt not found (run ~/development/stt/install.sh)', maxSeconds: 600 });
    const r = await upload(E.base, Buffer.from('x'), { type: 'audio/mp4' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, t.reason);
  } finally {
    await E.stop();
  }
});

test('an invalid transcription block disables dictation instead of breaking /api/config', async () => {
  const cfg = baseConfig({ transcription: { maxBytes: SMALL_MAX_BYTES, maxSeconds: SMALL_MAX_SECONDS } });
  try {
    // A hand-edit gone wrong: the block must be an object.
    await B.writeConfig({ ...cfg, transcription: 'on' });
    const r = await fetch(B.base + '/api/config');
    assert.equal(r.status, 200, 'the launcher itself must keep working');
    const c = await r.json();
    assert.equal(c.modes.length, 2);
    assert.equal(c.transcribe.enabled, false);
    assert.match(c.transcribe.reason, /invalid transcription config/);
    // A page opened before the edit still uploads: that must be a clean refusal
    // (no Retry on the phone), not a 500 on a half-read keep-alive socket.
    const up = await upload(B.base, Buffer.from('x'), { type: 'audio/mp4' });
    assert.equal(up.status, 503);
    assert.match(up.json.error, /invalid transcription config/);
  } finally {
    await B.writeConfig(cfg);
  }
});

// ---------- happy paths ----------

test('fragmented MP4/AAC (iOS) is normalized to mono 16 kHz mp3 and transcribed', { skip: needsAudio }, async () => {
  stub.reset();
  const r = await upload(A.base, await readFile(clips.mp4), { type: 'audio/mp4;codecs=mp4a.40.2' });
  assert.equal(r.status, 202);
  assert.match(r.json.id, UUID_RE);
  const job = await waitJob(A.base, r.json.id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.text, STUB_TEXT.trim());
  assert.equal(job.language, 'en');
  assert.equal(job.id, r.json.id);
  assert.ok(Math.abs(job.durationMs - clips.speechSeconds * 1000) < 500, `durationMs ${job.durationMs} vs ${clips.speechSeconds} s`);
  assert.equal(job.cacheControl, 'no-store');

  // What stt was given.
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.deepEqual(call.argv, STT_ARGS);
  assert.deepEqual(call.tempDirs, [], 'the clip must be off the disk before stt runs');
  const sent = path.join(work, 'sent.mp3');
  await writeFile(sent, call.audio);
  const a = await probeAudio(sent);
  assert.equal(a.codec, 'mp3');
  assert.equal(a.sampleRate, 16000);
  assert.equal(a.channels, 1);
  assert.ok(Math.abs(a.duration - clips.speechSeconds) < 0.5, `sent ${a.duration} s`);
  await assertNoTempDirs(A);
});

test('WebM/Opus (Firefox, older Chrome) is transcribed and the detected language passed on', { skip: needsAudio }, async () => {
  stub.reset();
  stub.outcomes.push({ language: 'pt' });
  const job = await transcribe(A, clips.webm, 'audio/webm;codecs=opus');
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.text, STUB_TEXT.trim());
  assert.equal(job.language, 'pt');
  assert.ok(Math.abs(job.durationMs - clips.speechSeconds * 1000) < 500);
  assert.equal(stub.calls.length, 1);
  await assertNoTempDirs(A);
});

test('silence: an empty transcript is a finished job with empty text', { skip: needsAudio }, async () => {
  stub.reset();
  stub.outcomes.push({ text: '' });
  const job = await transcribe(A, clips.mp4);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.text, '');
  assert.equal(job.language, undefined);
  await assertNoTempDirs(A);
});

test('the job is done once stt writes the transcript, without waiting for its cleanup', { skip: needsAudio }, async () => {
  stub.reset();
  stub.outcomes.push({ cleanup: 'hold' });
  const r = await upload(A.base, await readFile(clips.mp4));
  assert.equal(r.status, 202);
  // The held cleanup would keep a server that waits for stt's exit processing.
  const job = await waitJob(A.base, r.json.id, 10000);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.text, STUB_TEXT.trim());
  const { pid } = stub.calls[0];
  assert.ok(!processGone(pid), 'stt had already exited, so this proves nothing');
  stub.release();
  assert.ok(await waitFor(() => processGone(pid), { timeout: 3000 }), 'stt never finished its cleanup');
  await assertNoTempDirs(A);
});

// ---------- failures at stt ----------

test('stt failing is a retryable job error carrying its stt: line, never the progress lines', { skip: needsAudio }, async () => {
  stub.reset();
  stub.outcomes.push({ exit: 4, message: 'HTTP 402 Payment Required: no credit left' });
  const job = await transcribe(A, clips.mp4);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'stt: HTTP 402 Payment Required: no credit left');
  assert.equal(job.text, undefined);
  assert.equal(job.retryable, true, 'failures past ffmpeg may succeed on a retry');
  assert.equal(job.code, undefined);
  // Cut for the phone, whatever stt sends.
  stub.outcomes.push({ exit: 5, message: `network: ${'x'.repeat(400)}` });
  const long = await transcribe(A, clips.mp4);
  assert.equal(long.error.length, 300);
  assert.equal(long.retryable, true);
  await assertNoTempDirs(A);
});

test('a config problem at stt (exit 3) is not retryable, and the next /api/config checks again', { skip: needsAudio }, async () => {
  stub.reset();
  const F = await startServer({ config: baseConfig(), env: stub.env });
  try {
    assert.equal((await transcribeConfig(F)).enabled, true);
    const problem = 'soniox_api_key is not set in /home/someone/.config/stt/config';
    stub.outcomes.push({ exit: 3, message: problem });
    const job = await transcribe(F, clips.mp4);
    assert.equal(stub.checks.length, 1, 'the upload reuses a fresh OK check');
    assert.equal(job.status, 'error');
    assert.equal(job.error, `stt: ${problem}`);
    assert.equal(job.retryable, false, 'the same clip fails the same way until the config is fixed');
    assert.equal(job.code, 'config');

    stub.check = { exit: 3, message: problem };
    assert.deepEqual(await transcribeConfig(F), { enabled: false, reason: problem, maxSeconds: 600 });
    assert.equal(stub.checks.length, 2, 'the failed job dropped the cached OK');
    stub.check = { exit: 0 };
    assert.equal((await transcribeConfig(F)).enabled, true, 'fixing it turns the mic back on at once');
    await assertNoTempDirs(F);
  } finally {
    await F.stop();
  }
});

test('stt output the server cannot use is a retryable error that never echoes it', { skip: needsAudio }, async () => {
  stub.reset();
  const cases = [
    [{ raw: 'Speaker A: not json at all\n' }, 'stt answered with something other than a JSON transcript'],
    [{ raw: '{"provider": "stub"}\n' }, 'stt answered with something other than a JSON transcript'],
    // A crash without stt's own last line: the traceback stays off the phone.
    [{ exit: 1, stderr: 'Traceback (most recent call last):\n  File "cli.py"\nValueError: secret detail\n' }, 'stt exited with status 1'],
    [{ raw: 'y'.repeat(1.5 * 1024 * 1024) }, 'stt printed more than 1 MB'],
  ];
  for (const [outcome, want] of cases) {
    stub.outcomes.push(outcome);
    const job = await transcribe(A, clips.mp4);
    assert.equal(job.status, 'error', want);
    assert.equal(job.error, want);
    assert.equal(job.retryable, true, want);
  }
  assert.ok(!A.log.includes('not json') && !A.log.includes('secret detail') && !A.log.includes('yyyy'), 'stt output reached the log');
  await assertNoTempDirs(A);
});

test('stt still running at the backstop is stopped (SIGTERM, then SIGKILL) and the job times out', { skip: needsAudio }, async () => {
  stub.reset();
  const H = await startServer({ config: baseConfig(), env: { ...stub.env, CLAUDE_LAUNCHER_STT_BACKSTOP_MS: '1000' } });
  try {
    stub.outcomes.push({ hang: true }, { hang: true, ignoreTerm: true });
    for (const label of ['stops on SIGTERM', 'ignores SIGTERM']) {
      const job = await transcribe(H, clips.mp4);
      assert.equal(job.status, 'error', label);
      assert.equal(job.error, 'transcription timed out', label);
      assert.equal(job.retryable, true, label);
      assert.ok(processGone(stub.calls.at(-1).pid), `${label}: stt still running`);
    }
    assert.match(H.log, /stt still running after 1 s; stopping it/);
    await assertNoTempDirs(H);
  } finally {
    await H.stop();
  }
});

test('a cleanup that the backstop cuts short keeps the transcript stt already wrote', { skip: needsAudio }, async () => {
  stub.reset();
  // Long enough that the transcript is out well before it.
  const H = await startServer({ config: baseConfig(), env: { ...stub.env, CLAUDE_LAUNCHER_STT_BACKSTOP_MS: '2000' } });
  try {
    stub.outcomes.push({ cleanup: 'hang' });
    const job = await transcribe(H, clips.mp4);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.text, STUB_TEXT.trim());
    // Still reaped: the backstop outlives the job.
    const { pid } = stub.calls[0];
    assert.ok(await waitFor(() => processGone(pid), { timeout: 5000 }), 'the backstop left stt running');
    assert.match(H.log, /stt still running after 2 s, past its transcript; stopping it/);
    assert.match(H.log, /stt exited with status 143 after its transcript: stt: SIGTERM arrived after the transcript was written/);
    assert.ok(!H.log.includes('timed out'), H.log);
    await assertNoTempDirs(H);
  } finally {
    await H.stop();
  }
});

// ---------- the real stt ----------

test('through the real stt and its fake provider: a transcript, a refusal, a config problem', { skip: needsAudio || (!REAL_STT && 'needs stt on PATH') }, async () => {
  const sttConfig = path.join(work, 'stt.conf');
  await writeFile(sttConfig, 'provider = fake\n', { mode: 0o600 });
  const R = await startServer({ config: baseConfig(), env: { CLAUDE_LAUNCHER_STT: REAL_STT, STT_CONFIG: sttConfig } });
  try {
    assert.deepEqual(await transcribeConfig(R), { enabled: true, reason: null, maxSeconds: 600 });

    const job = await transcribe(R, clips.mp4);
    assert.equal(job.status, 'done', JSON.stringify(job));
    // The fake provider says what it got: audio from stdin, and how many bytes.
    const m = /^fake transcript of audio \((\d+) bytes\)$/.exec(job.text);
    assert.ok(m && Number(m[1]) > 1000, job.text);
    assert.equal(job.language, 'en');

    await writeFile(sttConfig, 'provider = fake\nfake_fail = submit:credit\n');
    const refused = await transcribe(R, clips.mp4);
    assert.equal(refused.status, 'error');
    assert.equal(refused.error, 'stt: HTTP 402 Payment Required: fake credit failure');
    assert.equal(refused.retryable, true);

    await writeFile(sttConfig, 'provider = soniox\n');
    const noKey = await transcribe(R, clips.mp4);
    assert.equal(noKey.status, 'error');
    assert.equal(noKey.error, `stt: soniox_api_key is not set in ${sttConfig}`);
    assert.equal(noKey.retryable, false);
    assert.equal(noKey.code, 'config');
    assert.deepEqual(await transcribeConfig(R), { enabled: false, reason: `soniox_api_key is not set in ${sttConfig}`, maxSeconds: 600 });

    assert.ok(!R.log.includes('fake transcript of'), 'transcript text reached the log');
    await assertNoTempDirs(R);
  } finally {
    await R.stop();
  }
});

// ---------- bad audio ----------

test('a 0.2 s clip is "no audio captured" and never reaches stt', { skip: needsAudio }, async () => {
  stub.reset();
  const job = await transcribe(A, clips.short);
  assert.equal(job.status, 'error');
  assert.match(job.error, /no audio captured/);
  // The same clip fails the same way: the phone must not offer Retry.
  assert.equal(job.retryable, false);
  assert.equal(job.code, 'no_audio');
  assert.equal(stub.calls.length, 0);
  await assertNoTempDirs(A);
});

test('a non-audio body labelled audio/mp4 is a job error, and the message hides temp paths', { skip: needsAudio }, async () => {
  stub.reset();
  const r = await upload(A.base, Buffer.from('this is not audio\n'.repeat(400)), { type: 'audio/mp4' });
  assert.equal(r.status, 202);
  const job = await waitJob(A.base, r.json.id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /no audio captured/);
  assert.ok(!job.error.includes(A.tmp) && !job.error.includes('claude-launcher-dictation-'), job.error);
  assert.equal(stub.calls.length, 0);
  await assertNoTempDirs(A);
});

test('a recording longer than maxSeconds (+5 s grace) is refused', { skip: needsAudio }, async () => {
  stub.reset();
  const job = await transcribe(B, clips.long);
  assert.equal(job.status, 'error');
  assert.match(job.error, /longer than the 0:02 limit/);
  assert.equal(job.retryable, false);
  assert.equal(job.code, 'too_long');
  assert.equal(stub.calls.length, 0);
  await assertNoTempDirs(B);
});

test('a DASH manifest cannot make ffmpeg read a local file', { skip: needsAudio }, async () => {
  stub.reset();
  // Uploaded as audio/mp4, the manifest names a file on this PC. Probed freely,
  // ffmpeg's dash demuxer would open it, and its audio would be transcribed.
  const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT5S" minBufferTime="PT1S">
 <Period><AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="64000" codecs="mp4a.40.2"><BaseURL>${victim}</BaseURL></Representation></AdaptationSet></Period>
</MPD>`;
  const r = await upload(A.base, Buffer.from(mpd), { type: 'audio/mp4' });
  assert.equal(r.status, 202);
  const job = await waitJob(A.base, r.json.id);
  assert.equal(job.status, 'error', JSON.stringify(job));
  assert.equal(job.durationMs, undefined);
  assert.equal(stub.calls.length, 0, 'the local file reached stt');
  await assertNoTempDirs(A);
});

test('ffmpeg killed for flooding stderr is a failed conversion, not a truncated success', { skip: needsAudio }, async () => {
  stub.reset();
  // A clip full of decode errors can make ffmpeg log more than server.mjs buffers;
  // Node then SIGKILLs it mid-file. This stand-in converts fully and then floods,
  // so a server that ignores the kill reports "done" where it must report an error.
  const bin = path.join(work, 'noisy-bin');
  await rm(bin, { recursive: true, force: true });
  await mkdir(bin);
  const real = (await execFileP('sh', ['-c', 'command -v ffmpeg'])).stdout.trim();
  await writeFile(path.join(bin, 'ffmpeg'), [
    '#!/bin/sh',
    `${JSON.stringify(real)} "$@" || exit $?`,
    'case "$*" in *speech.mp3*) head -c 1200000 /dev/zero | tr "\\0" e >&2 ;; esac',
    '',
  ].join('\n'));
  await chmod(path.join(bin, 'ffmpeg'), 0o755);
  const C = await startServer({
    config: baseConfig(),
    env: { ...stub.env, PATH: `${bin}:${process.env.PATH}` },
  });
  try {
    const job = await transcribe(C, clips.mp4);
    assert.equal(job.status, 'error', JSON.stringify(job));
    assert.match(job.error, /audio conversion failed/);
    assert.equal(stub.calls.length, 0);
    await assertNoTempDirs(C);
  } finally {
    await C.stop();
  }
});

// ---------- refusals before the body is read ----------

test('415 for anything that is not audio/*, and the connection is closed', async () => {
  for (const type of ['application/octet-stream', 'text/plain', 'video/mp4', 'multipart/form-data; boundary=x', null]) {
    const r = await upload(A.base, Buffer.from('xyz'), { type });
    assert.equal(r.status, 415, `type ${type}`);
    assert.match(r.json.error, /audio/);
    assert.equal(r.headers.get('connection'), 'close', `type ${type}`);
  }
  await assertNoTempDirs(A);
});

test('413 on an oversized Content-Length: refused before the body is read, socket closed', async () => {
  const s = rawSocket(B.port);
  await s.connected;
  s.sock.write(`POST /api/transcribe HTTP/1.1\r\nHost: 127.0.0.1:${B.port}\r\nContent-Type: audio/mp4\r\n`
    + `Content-Length: ${SMALL_MAX_BYTES + 1}\r\nConnection: keep-alive\r\n\r\n`);
  s.sock.write(Buffer.alloc(1000, 1)); // a sliver of the declared body, then silence
  await withTimeout(s.closedP, 3000);
  assert.match(s.data, /^HTTP\/1\.1 413 /);
  assert.match(s.data, /\r\nconnection: close\r\n/i);
  assert.ok(s.closed, 'the server kept the socket open waiting for a body it had refused');
  assert.equal(s.data.split('HTTP/1.1 ').length - 1, 1, 'exactly one response on the connection');
  s.sock.destroy();
  await assertNoTempDirs(B);
});

// needsAudio: a server without ffmpeg answers 503 before it reads a chunked body.
test('413 when a chunked body grows past maxBytes: the socket is dropped, nothing kept', { skip: needsAudio }, async () => {
  const s = rawSocket(B.port);
  await s.connected;
  s.sock.write(`POST /api/transcribe HTTP/1.1\r\nHost: 127.0.0.1:${B.port}\r\nContent-Type: audio/mp4\r\n`
    + 'Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n');
  const chunk = Buffer.alloc(16 * 1024, 7);
  let sent = 0;
  // Stop just past the cap, so the server has read all we sent and hangs up
  // with a FIN rather than a reset that could swallow the 413.
  while (sent <= SMALL_MAX_BYTES && !s.closed) {
    s.sock.write(`${chunk.length.toString(16)}\r\n`);
    s.sock.write(chunk);
    s.sock.write('\r\n');
    sent += chunk.length;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await withTimeout(s.closedP, 3000);
  assert.match(s.data, /^HTTP\/1\.1 413 /);
  assert.match(s.data, /\r\nconnection: close\r\n/i);
  assert.ok(s.closed, 'the socket stayed open with a half-read body');
  s.sock.destroy();
  await assertNoTempDirs(B);
});

test('400 for an empty body (Content-Length: 0, and an empty chunked body)', { skip: needsAudio }, async () => {
  const r = await upload(A.base, Buffer.alloc(0));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /empty/);

  const s = rawSocket(A.port);
  await s.connected;
  s.sock.write(`POST /api/transcribe HTTP/1.1\r\nHost: 127.0.0.1:${A.port}\r\nContent-Type: audio/mp4\r\n`
    + 'Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n');
  await withTimeout(s.closedP, 3000);
  assert.match(s.data, /^HTTP\/1\.1 400 /);
  s.sock.destroy();
  await assertNoTempDirs(A);
});

test('cross-site browser requests are blocked (Sec-Fetch-Site)', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = await upload(A.base, Buffer.from('xyz'), { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(r.status, 403, `POST ${site}`);
    const g = await fetch(`${A.base}/api/transcribe/${randomUUID()}`, { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(g.status, 403, `GET ${site}`);
  }
});

test('unknown or malformed job ids are 404', async () => {
  for (const id of [randomUUID(), 'nope', '..%2Fconfig', '']) {
    const r = await fetch(`${A.base}/api/transcribe/${id}`);
    assert.equal(r.status, 404, `id "${id}"`);
    assert.ok((await r.json()).error);
  }
});

// ---------- resources ----------

test('a client that gives up mid-upload leaves no temp files (0700 dir, 0600 file meanwhile)', { skip: needsAudio }, async () => {
  const s = rawSocket(A.port);
  await s.connected;
  s.sock.write(`POST /api/transcribe HTTP/1.1\r\nHost: 127.0.0.1:${A.port}\r\nContent-Type: audio/mp4\r\n`
    + 'Content-Length: 100000\r\n\r\n');
  s.sock.write(Buffer.alloc(30000, 3));
  const partial = await waitFor(async () => {
    const [d] = await A.tempDirs();
    if (!d) return null;
    const f = path.join(A.tmp, d, 'upload');
    try { return (await stat(f)).size === 30000 ? { dir: path.join(A.tmp, d), file: f } : null; } catch { return null; }
  }, { timeout: 3000 });
  assert.ok(partial, 'the partial upload never appeared on disk');
  assert.equal((await stat(partial.dir)).mode & 0o777, 0o700);
  assert.equal((await stat(partial.file)).mode & 0o777, 0o600);
  s.sock.destroy();
  await assertNoTempDirs(A);
  assert.match(A.log, /upload aborted by the client after 30000 B/);
});

test('at most 4 transcriptions at once: the fifth upload gets 429, and slots come back', { skip: needsAudio }, async () => {
  stub.reset();
  for (let i = 0; i < 4; i++) stub.outcomes.push({ hold: true });
  const audio = await readFile(clips.mp4);
  const first = await Promise.all([0, 1, 2, 3].map(() => upload(A.base, audio)));
  assert.deepEqual(first.map((r) => r.status), [202, 202, 202, 202]);
  const fifth = await upload(A.base, audio);
  assert.equal(fifth.status, 429);
  assert.equal(fifth.headers.get('connection'), 'close');

  assert.ok(await waitFor(() => stub.calls.length === 4, { timeout: 10000 }), 'the four jobs never reached stt');
  stub.release();
  const jobs = await Promise.all(first.map((r) => waitJob(A.base, r.json.id)));
  assert.deepEqual(jobs.map((j) => j.status), ['done', 'done', 'done', 'done']);

  const again = await transcribe(A, clips.mp4);
  assert.equal(again.status, 'done');
  await assertNoTempDirs(A);
});

test('SIGTERM mid-upload removes the clip before the server exits', { skip: needsAudio }, async () => {
  const S = await startServer({ config: baseConfig(), env: stub.env });
  try {
    const s = rawSocket(S.port);
    await s.connected;
    s.sock.write(`POST /api/transcribe HTTP/1.1\r\nHost: 127.0.0.1:${S.port}\r\nContent-Type: audio/mp4\r\n`
      + 'Content-Length: 100000\r\n\r\n');
    s.sock.write(Buffer.alloc(30000, 3));
    const partial = await waitFor(async () => {
      const [d] = await S.tempDirs();
      if (!d) return false;
      try { return (await stat(path.join(S.tmp, d, 'upload'))).size === 30000; } catch { return false; }
    }, { timeout: 3000 });
    assert.ok(partial, 'the partial upload never appeared on disk');
    const exited = once(S.proc, 'exit');
    S.proc.kill('SIGTERM'); // what `systemctl --user stop` sends
    await exited;
    assert.equal(S.proc.signalCode, 'SIGTERM', 'the exit status systemd sees is unchanged');
    assert.deepEqual(await S.tempDirs(), [], 'the clip outlived the server');
    s.sock.destroy();
  } finally {
    await S.stop();
  }
});

test('SIGTERM while stt runs stops stt too, so it deletes the provider job', { skip: needsAudio }, async () => {
  stub.reset();
  const S = await startServer({ config: baseConfig(), env: stub.env });
  try {
    stub.outcomes.push({ hang: true });
    const r = await upload(S.base, await readFile(clips.mp4));
    assert.equal(r.status, 202);
    assert.ok(await waitFor(() => stub.calls.length === 1, { timeout: 10000 }), 'stt never ran');
    const exited = once(S.proc, 'exit');
    S.proc.kill('SIGTERM');
    await exited;
    assert.equal(S.proc.signalCode, 'SIGTERM', 'the exit status systemd sees is unchanged');
    // The stand-in only exits early on SIGTERM; otherwise it hangs for a minute.
    assert.ok(await waitFor(() => processGone(stub.calls[0].pid), { timeout: 3000 }), 'stt outlived the server');
  } finally {
    await S.stop();
  }
});

// Last, so it sees every log line the cases above produced.
test('the server logs never contain the transcript text', async () => {
  for (const [name, s] of [['A', A], ['B', B]]) {
    assert.ok(!s.log.includes(STUB_TEXT.trim()), `server ${name} logged transcript text`);
  }
  // Sanity check that the logs were captured at all.
  if (!needsAudio) assert.match(A.log, /\[transcribe\] .* done: .*, stub; ffmpeg \d+ ms, stt \d+ ms, total \d+ ms/);
  assert.deepEqual(await readdir(A.tmp), []);
  assert.deepEqual(await readdir(B.tmp), []);
});
