// The dictation API end to end: the real server.mjs, real ffmpeg, a stub
// AssemblyAI. Run with:  node --test test/transcribe.test.mjs
//
// Two servers run side by side: A takes its key from ASSEMBLYAI_API_KEY, B from
// a fake key file and has small maxBytes/maxSeconds for the limit cases. Neither
// touches the live service, its config.json or the real key file.
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
  UUID_RE, missingTools, makeClips, probeAudio, startAssemblyAIStub, startServer,
  baseConfig, upload, waitJob, waitFor,
} from './harness.mjs';

const ENV_KEY = `env-key-${randomUUID()}`;
const FILE_KEY = `file-key-${randomUUID()}`;
const OLD_FILE_KEY = `old-file-key-${randomUUID()}`;
// Padded on purpose: the server must hand the phone trimmed text.
const STUB_TEXT = '  Refactor the upload handler and add a test.  ';
const SMALL_MAX_BYTES = 200_000;
const SMALL_MAX_SECONDS = 2;

const execFileP = promisify(execFile);
const missing = await missingTools();
// Everything that needs a clip or an enabled server (which itself needs ffmpeg).
const needsAudio = missing.length ? `needs ${missing.join(', ')}` : false;

let work;
let clips;
let stub;
let A;
let B;
let keyFile;
let victim; // a local audio file the DASH case must not be able to reach

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'claude-launcher-test-work-'));
  keyFile = path.join(work, 'aai.conf');
  // Same shape as ~/.config/audiorecorder/config: an old key commented out, then
  // two live lines (the last one must win), and key terms with junk to clean up.
  await writeFile(keyFile, [
    '# AssemblyAI',
    `# assemblyai_api_key=${OLD_FILE_KEY}`,
    `assemblyai_api_key=${OLD_FILE_KEY}`,
    `assemblyai_api_key = ${FILE_KEY} `,
    'assemblyai_keyterms=Claude, tmux , , Playwright, one two three four five six seven, server.mjs, Claude',
    '',
  ].join('\n'), { mode: 0o600 });
  stub = await startAssemblyAIStub({ text: STUB_TEXT, language: 'en' });
  if (!needsAudio) {
    clips = await makeClips(work);
    victim = path.join(work, 'victim.m4a');
    await execFileP('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', clips.wav, '-c:a', 'aac', victim], { timeout: 30000 });
  }
  A = await startServer({
    config: baseConfig({ keyFile }),
    env: { ASSEMBLYAI_API_KEY: ENV_KEY, ASSEMBLYAI_BASE_URL: stub.url },
  });
  B = await startServer({
    config: baseConfig({ keyFile, transcription: { maxBytes: SMALL_MAX_BYTES, maxSeconds: SMALL_MAX_SECONDS } }),
    env: { ASSEMBLYAI_BASE_URL: stub.url },
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
  const a = await (await fetch(A.base + '/api/config')).json();
  assert.deepEqual(a.transcribe, { enabled: true, reason: null, maxSeconds: 600 });
  const b = await (await fetch(B.base + '/api/config')).json();
  assert.deepEqual(b.transcribe, { enabled: true, reason: null, maxSeconds: SMALL_MAX_SECONDS });
  // The key must never reach the phone.
  assert.ok(!JSON.stringify(a).includes(ENV_KEY) && !JSON.stringify(b).includes(FILE_KEY));
});

test('no resolvable key disables dictation with a reason, re-evaluated without a restart', { skip: needsAudio }, async () => {
  stub.reset();
  const noKey = path.join(work, 'nokey.conf');
  await writeFile(noKey, `# assemblyai_api_key=${OLD_FILE_KEY}\nassemblyai_keyterms=Claude\n`, { mode: 0o600 });
  const cfg = baseConfig({ keyFile: noKey, transcription: { maxBytes: SMALL_MAX_BYTES, maxSeconds: SMALL_MAX_SECONDS } });
  try {
    await B.writeConfig(cfg);
    const t = (await (await fetch(B.base + '/api/config')).json()).transcribe;
    assert.equal(t.enabled, false);
    assert.match(t.reason, /no AssemblyAI key/);
    const r = await upload(B.base, await readFile(clips.mp4));
    assert.equal(r.status, 503);
    assert.equal(r.json.error, t.reason);
    assert.equal(r.headers.get('connection'), 'close');

    await B.writeConfig({ ...cfg, transcription: { ...cfg.transcription, keyFile, enabled: false } });
    const off = (await (await fetch(B.base + '/api/config')).json()).transcribe;
    assert.equal(off.enabled, false);
    assert.match(off.reason, /disabled/);
  } finally {
    await B.writeConfig(baseConfig({ keyFile, transcription: { maxBytes: SMALL_MAX_BYTES, maxSeconds: SMALL_MAX_SECONDS } }));
  }
  const back = (await (await fetch(B.base + '/api/config')).json()).transcribe;
  assert.equal(back.enabled, true, 'restoring the key file re-enables dictation without a restart');
  assert.equal(stub.requests.length, 0, 'nothing may reach AssemblyAI while disabled');
});

test('an invalid transcription block disables dictation instead of breaking /api/config', async () => {
  const cfg = baseConfig({ keyFile, transcription: { maxBytes: SMALL_MAX_BYTES, maxSeconds: SMALL_MAX_SECONDS } });
  try {
    // A hand-edit gone wrong: keyFile must be a string.
    await B.writeConfig({ ...cfg, transcription: { ...cfg.transcription, keyFile: 5 } });
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

  // What AssemblyAI was sent.
  assert.equal(stub.uploads.length, 1);
  const up = stub.uploads[0];
  assert.equal(up.auth, ENV_KEY, 'the env key wins over the key file');
  assert.equal(up.contentType, 'application/octet-stream');
  const sent = path.join(work, 'sent.mp3');
  await writeFile(sent, up.body);
  const a = await probeAudio(sent);
  assert.equal(a.codec, 'mp3');
  assert.equal(a.sampleRate, 16000);
  assert.equal(a.channels, 1);
  assert.ok(Math.abs(a.duration - clips.speechSeconds) < 0.5, `uploaded ${a.duration} s`);

  assert.equal(stub.submits.length, 1);
  const s = stub.submits[0];
  assert.equal(s.auth, ENV_KEY);
  assert.equal(s.contentType, 'application/json');
  assert.equal(s.json.audio_url, 'https://cdn.stub.invalid/upload/1');
  assert.deepEqual(s.json.speech_models, ['universal-3-5-pro', 'universal-2']);
  assert.equal(s.json.language_detection, true);
  assert.deepEqual(s.json.language_detection_options, {
    expected_languages: ['en', 'pt', 'de'], fallback_language: 'en', on_no_speech_detected: 'fallback',
  });
  // Trimmed, blanks and duplicates dropped, the seven-word phrase dropped.
  assert.deepEqual(s.json.keyterms_prompt, ['Claude', 'tmux', 'Playwright', 'server.mjs']);
  assert.ok(stub.requests.every((q) => q.auth === ENV_KEY));

  // Retention: the transcript is deleted at AssemblyAI once it is back.
  const [trId] = stub.transcripts.keys();
  assert.ok(await waitFor(() => stub.deletes.includes(trId), { timeout: 3000 }), 'DELETE /v2/transcript/<id> was not called');
  await assertNoTempDirs(A);
});

test('WebM/Opus (Firefox, older Chrome) is transcribed and the detected language passed on', { skip: needsAudio }, async () => {
  stub.reset();
  stub.outcomes.push({ language: 'pt', pollsBeforeDone: 2 }); // also walks the "processing" loop
  const job = await transcribe(A, clips.webm, 'audio/webm;codecs=opus');
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.text, STUB_TEXT.trim());
  assert.equal(job.language, 'pt');
  assert.ok(Math.abs(job.durationMs - clips.speechSeconds * 1000) < 500);
  assert.equal(stub.transcripts.size, 1);
  assert.ok(await waitFor(() => stub.deletes.length === 1, { timeout: 3000 }));
  await assertNoTempDirs(A);
});

test('without an env key the key file is used, last uncommented value winning', { skip: needsAudio }, async () => {
  stub.reset();
  const job = await transcribe(B, clips.mp4);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.ok(stub.requests.length > 0);
  assert.ok(stub.requests.every((q) => q.auth === FILE_KEY), JSON.stringify(stub.requests.map((q) => q.auth === OLD_FILE_KEY ? 'OLD' : q.auth === FILE_KEY ? 'LIVE' : 'OTHER')));
  await assertNoTempDirs(B);
});

// ---------- failures at AssemblyAI ----------

test('a transcript that fails at AssemblyAI becomes a job error carrying its message', { skip: needsAudio }, async () => {
  stub.reset();
  stub.outcomes.push({ error: 'Audio duration is too short.' });
  const job = await transcribe(A, clips.mp4);
  assert.equal(job.status, 'error');
  assert.match(job.error, /Audio duration is too short\./);
  assert.equal(job.text, undefined);
  assert.equal(job.retryable, true, 'failures past ffmpeg may succeed on a retry');
  // An errored transcript is final, so it can (and must) be deleted too.
  assert.ok(await waitFor(() => stub.deletes.length === 1, { timeout: 3000 }));
  await assertNoTempDirs(A);
});

test('AssemblyAI rejecting the upload (401) is a job error that never echoes the key', { skip: needsAudio }, async () => {
  stub.reset();
  // A hostile or buggy upstream quoting the key back must not get it to the phone.
  stub.uploadFailures.push({ status: 401, body: { error: `Invalid API key: ${ENV_KEY}` } });
  const job = await transcribe(A, clips.mp4);
  assert.equal(job.status, 'error');
  assert.match(job.error, /upload failed: HTTP 401/);
  assert.equal(job.retryable, true, 'the key is re-read per dictation, so fixing it then retrying works');
  assert.ok(!job.error.includes(ENV_KEY), 'key leaked into the job error');
  assert.match(job.error, /\[key\]/);
  assert.equal(stub.submits.length, 0);
  await assertNoTempDirs(A);
});

test('AssemblyAI failing the upload (500) is a job error', { skip: needsAudio }, async () => {
  stub.reset();
  stub.uploadFailures.push({ status: 500, body: '<html>internal error</html>' });
  const job = await transcribe(A, clips.mp4);
  assert.equal(job.status, 'error');
  assert.match(job.error, /upload failed: HTTP 500/);
  await assertNoTempDirs(A);
});

test('a burst of fast poll failures is waited out, not counted against the job', { skip: needsAudio }, async () => {
  stub.reset();
  // Five resets in a row, each failing at once: what a Wi-Fi roam or a DNS hiccup
  // on the PC looks like. The transcript is ready the moment the network is back.
  for (let i = 0; i < 5; i++) stub.pollFailures.push({ reset: true });
  const job = await transcribe(A, clips.mp4);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.text, STUB_TEXT.trim());
  assert.equal(stub.pollFailures.length, 0, 'every scripted failure was hit');
  await assertNoTempDirs(A);
});

test('a transient failure deleting the transcript at AssemblyAI is retried', { skip: needsAudio }, async () => {
  stub.reset();
  stub.deleteFailures.push({ reset: true });
  const job = await transcribe(A, clips.mp4);
  assert.equal(job.status, 'done', JSON.stringify(job));
  const [trId] = stub.transcripts.keys();
  assert.ok(await waitFor(() => stub.deletes.includes(trId), { timeout: 6000 }), 'the transcript was left at AssemblyAI');
  assert.equal(stub.deleteFailures.length, 0);
});

test('key terms rejected by AssemblyAI: the submit is retried once without them', { skip: needsAudio }, async () => {
  stub.reset();
  stub.submitFailures.push({ status: 400, body: { error: 'keyterms_prompt is invalid' }, onlyWithKeyterms: true });
  const job = await transcribe(A, clips.mp4);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(stub.submits.length, 2);
  assert.ok(Array.isArray(stub.submits[0].json.keyterms_prompt));
  assert.equal(stub.submits[1].json.keyterms_prompt, undefined);
});

// ---------- bad audio ----------

test('a 0.2 s clip is "no audio captured" and never reaches AssemblyAI', { skip: needsAudio }, async () => {
  stub.reset();
  const job = await transcribe(A, clips.short);
  assert.equal(job.status, 'error');
  assert.match(job.error, /no audio captured/);
  // The same clip fails the same way: the phone must not offer Retry.
  assert.equal(job.retryable, false);
  assert.equal(job.code, 'no_audio');
  assert.equal(stub.requests.length, 0);
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
  assert.equal(stub.requests.length, 0);
  await assertNoTempDirs(A);
});

test('a recording longer than maxSeconds (+5 s grace) is refused', { skip: needsAudio }, async () => {
  stub.reset();
  const job = await transcribe(B, clips.long);
  assert.equal(job.status, 'error');
  assert.match(job.error, /longer than the 0:02 limit/);
  assert.equal(job.retryable, false);
  assert.equal(job.code, 'too_long');
  assert.equal(stub.requests.length, 0);
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
  assert.equal(stub.requests.length, 0, 'the local file reached AssemblyAI');
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
    config: baseConfig({ keyFile }),
    env: { ASSEMBLYAI_API_KEY: ENV_KEY, ASSEMBLYAI_BASE_URL: stub.url, PATH: `${bin}:${process.env.PATH}` },
  });
  try {
    const job = await transcribe(C, clips.mp4);
    assert.equal(job.status, 'error', JSON.stringify(job));
    assert.match(job.error, /audio conversion failed/);
    assert.equal(stub.requests.length, 0);
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

  assert.ok(await waitFor(() => stub.transcripts.size === 4, { timeout: 10000 }), 'the four jobs never reached AssemblyAI');
  stub.release();
  const jobs = await Promise.all(first.map((r) => waitJob(A.base, r.json.id)));
  assert.deepEqual(jobs.map((j) => j.status), ['done', 'done', 'done', 'done']);

  const again = await transcribe(A, clips.mp4);
  assert.equal(again.status, 'done');
  await assertNoTempDirs(A);
});

test('SIGTERM mid-upload removes the clip before the server exits', { skip: needsAudio }, async () => {
  const S = await startServer({
    config: baseConfig({ keyFile }),
    env: { ASSEMBLYAI_API_KEY: ENV_KEY, ASSEMBLYAI_BASE_URL: stub.url },
  });
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

// Last, so it sees every log line the cases above produced.
test('the server logs never contain the key or the transcript text', async () => {
  for (const [name, s] of [['A', A], ['B', B]]) {
    for (const secret of [ENV_KEY, FILE_KEY, OLD_FILE_KEY]) assert.ok(!s.log.includes(secret), `server ${name} logged a key`);
    assert.ok(!s.log.includes(STUB_TEXT.trim()), `server ${name} logged transcript text`);
  }
  // Sanity check that the logs were captured at all.
  if (!needsAudio) assert.match(A.log, /\[transcribe\] .* done: /);
  assert.deepEqual(await readdir(A.tmp), []);
  assert.deepEqual(await readdir(B.tmp), []);
});
