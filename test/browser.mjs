// Dictation in a real browser: Chromium with a fake microphone playing an
// espeak-ng clip, against the real server.mjs (and so real ffmpeg on whatever
// Chromium's MediaRecorder produced) with a stub AssemblyAI behind it.
//
//   node test/browser.mjs
//
// Chromium records MP4 or WebM with Opus, never the AAC an iPhone produces, so
// this covers the page's plumbing; test/transcribe.test.mjs covers iOS-shaped
// uploads on the server side.
//
// The launch buttons are never clicked, and /api/launch is aborted at the network
// layer as well: a launch would start a real tmux + claude session.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { missingTools, makeClips, probeAudio, startAssemblyAIStub, startServer, baseConfig, waitFor } from './harness.mjs';

// The app has no npm dependencies, so there is no local node_modules to find
// Playwright in unless someone installed one: fall back to the global install.
async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed locally */ }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href);
}
const { chromium } = await loadPlaywright();

// What the stub "hears", padded to prove the page gets trimmed text.
const STUB_TEXT = 'the null check in the parser and';
const ENV_KEY = `browser-test-key-${randomUUID()}`;
const DRAFT_KEY = 'claude-launcher.draft';
const PENDING_KEY = 'claude-launcher.dictation';

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `   ${detail}` : ''}`);
  }
}

const missing = await missingTools();
if (missing.length) {
  console.log(`SKIPPED: needs ${missing.join(', ')}`);
  process.exit(0);
}

const work = await mkdtemp(path.join(os.tmpdir(), 'claude-launcher-browser-'));
let stub;
let server;
let browser;
// A hung wait must not leave the server, the stub or Chromium behind.
const watchdog = setTimeout(() => {
  console.log('FAIL  the run took longer than 3 minutes');
  failures++;
  cleanup().finally(() => process.exit(1));
}, 3 * 60 * 1000);

async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.stop().catch(() => {});
  if (stub) await stub.close().catch(() => {});
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

try {
  const clips = await makeClips(work, 'Please fix the failing upload test and then run the whole suite again.');
  const keyFile = path.join(work, 'aai.conf');
  await writeFile(keyFile, 'assemblyai_keyterms=Claude\n', { mode: 0o600 });
  stub = await startAssemblyAIStub({ text: `  ${STUB_TEXT}  `, language: 'en' });
  server = await startServer({
    config: baseConfig({ keyFile }),
    env: { ASSEMBLYAI_API_KEY: ENV_KEY, ASSEMBLYAI_BASE_URL: stub.url },
  });
  const BASE = server.base;

  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream', // auto-accept the permission prompt
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${clips.wav}`,
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
  });

  let launchCalls = 0;
  await context.route('**/api/launch', (route) => { launchCalls++; route.abort(); });
  const uploads = []; // every POST /api/transcribe the page made
  const consoleErrors = [];
  const page = await context.newPage();
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/transcribe') {
      uploads.push({ type: r.headers()['content-type'], size: (r.postDataBuffer() || Buffer.alloc(0)).length });
    }
  });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${(m.location() || {}).url || ''}`); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const phase = () => page.getAttribute('#promptField', 'data-dictation');
  const waitPhase = (want, timeout = 20000) => page.waitForFunction(
    (p) => document.getElementById('promptField').dataset.dictation === p, want, { timeout });
  const launchDisabled = () => page.$$eval('.mode-btn', (bs) => bs.length > 0 && bs.every((b) => b.disabled));
  const launchEnabled = () => page.$$eval('.mode-btn', (bs) => bs.length > 0 && bs.every((b) => !b.disabled));
  const micDisabled = () => page.$eval('#micBtn', (b) => b.disabled);
  const toastShown = () => page.$eval('#toast', (t) => !t.classList.contains('hidden'));
  const toastText = async () => ((await toastShown()) ? page.textContent('#toast') : '');
  // The page's next fetch of `path` settles with `reply` ({ status, body } or
  // { reject: message }) without touching the network, so the client's handling
  // of each answer can be checked exactly.
  const scriptNextFetch = (path, reply) => page.evaluate(({ path, reply }) => {
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url) !== path) return real(url, opts);
      window.fetch = real;
      if (reply.reject) return Promise.reject(new TypeError(reply.reject));
      return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } }));
    };
  }, { path, reply });
  const value = () => page.inputValue('#prompt');
  const stored = (key) => page.evaluate((k) => localStorage.getItem(k), key);
  const seconds = (clock) => { const [m, s] = String(clock).split(':').map(Number); return m * 60 + s; };
  const load = async () => {
    await page.waitForSelector('.mode-btn');
    await page.waitForSelector('#micBtn:not([hidden])', { timeout: 5000 }).catch(() => {});
  };
  // Records `ms` of the fake microphone and taps stop.
  const dictate = async (ms) => {
    await page.click('#micBtn');
    await waitPhase('recording');
    await page.waitForTimeout(ms);
    await page.click('#micBtn');
  };

  // ---------- (a) record, stop, insert at the caret ----------
  console.log('\n(a) dictate into the middle of the prompt');
  await page.goto(BASE);
  await load();
  check('mic button shown (server reports dictation available)', await page.isVisible('#micBtn'));
  await page.fill('#prompt', 'Fix the bug');
  await page.click('#prompt');
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight'); // Fix|_the bug
  check('caret placed after "Fix"', (await page.$eval('#prompt', (t) => t.selectionStart)) === 3);

  await page.click('#micBtn');
  await waitPhase('recording');
  check('mic shows pressed while recording', (await page.getAttribute('#micBtn', 'aria-pressed')) === 'true');
  check('launch buttons disabled while recording', await launchDisabled());
  check('recording bar visible', await page.isVisible('#dictateBar'));
  await page.waitForTimeout(1200);
  const t1 = seconds(await page.textContent('#dictateElapsed'));
  let peak = 0;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(200);
    const tf = await page.$eval('#dictateLevel', (s) => s.style.transform);
    peak = Math.max(peak, Number((/scaleX\(([\d.]+)\)/.exec(tf) || [])[1] || 0));
  }
  const t2 = seconds(await page.textContent('#dictateElapsed'));
  check('elapsed timer advances', t2 >= t1 + 1 && t2 >= 3, `${t1} s -> ${t2} s`);
  check('level meter moves with the fake mic', peak > 0.05, `peak scaleX ${peak}`);
  check('launch buttons still disabled after 3 s', await launchDisabled());

  await page.click('#micBtn'); // stop
  await waitPhase('transcribing', 5000);
  check('launch buttons disabled while transcribing', await launchDisabled());
  await waitPhase('idle');
  const expectA = `Fix ${STUB_TEXT} the bug`;
  const vA = await value();
  check('transcript inserted at the caret with one space each side', vA === expectA, JSON.stringify(vA));
  check('caret left after the inserted text',
    (await page.$eval('#prompt', (t) => t.selectionStart)) === `Fix ${STUB_TEXT}`.length);
  check('launch buttons re-enabled', await launchEnabled());
  check('microphone released', await page.evaluate(() => !dict.stream && !dict.recorder && !dict.audioCtx));
  check('pending job id cleared', (await stored(PENDING_KEY)) === null);
  check('one upload, typed audio/*', uploads.length === 1 && /^audio\//.test(uploads[0].type || ''), JSON.stringify(uploads));
  check('the server passed one clip on to AssemblyAI', stub.uploads.length === 1, `stub uploads: ${stub.uploads.length}`);
  if (stub.uploads.length) {
    // Proves ffmpeg on the server decoded what Chromium's MediaRecorder wrote,
    // and that the clip covers the whole recording (about t2 + the stop flush).
    const sent = path.join(work, 'sent.mp3');
    await writeFile(sent, stub.uploads[0].body);
    const a = await probeAudio(sent);
    check('clip decoded on the server: mp3, mono 16 kHz, as long as the recording',
      a.codec === 'mp3' && a.channels === 1 && a.sampleRate === 16000 && a.duration > t2 - 0.5 && a.duration < t2 + 2.5,
      JSON.stringify(a));
  }
  console.log(`  info  page recorded ${uploads[0] && uploads[0].type}, ${uploads[0] && uploads[0].size} B`);

  // ---------- (b) the draft survives a reload ----------
  console.log('\n(b) draft persists across a reload');
  await page.click('#prompt');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' now');
  // Reload straight away, inside the 400 ms autosave debounce: pagehide must save it.
  await page.reload();
  await load();
  const vB = await value();
  check('draft restored after reload (saved on pagehide)', vB === `${expectA} now`, JSON.stringify(vB));
  check('draft stored in localStorage', (await stored(DRAFT_KEY)) === vB);

  // ---------- (c) cancel discards ----------
  console.log('\n(c) cancel discards the recording');
  const uploadsBefore = uploads.length;
  await page.click('#micBtn');
  await waitPhase('recording');
  await page.waitForTimeout(1500);
  await page.click('#dictateCancel');
  check('cancel returns to idle at once', (await phase()) === 'idle');
  await page.waitForTimeout(2000);
  check('no POST /api/transcribe after cancel', uploads.length === uploadsBefore, `${uploads.length - uploadsBefore} made`);
  check('prompt untouched by cancel', (await value()) === vB);
  check('launch buttons enabled after cancel', await launchEnabled());
  check('microphone released after cancel', await page.evaluate(() => !dict.stream && !dict.recorder));

  // ---------- (d) server error -> kept in the bar -> Retry succeeds ----------
  console.log('\n(d) a failed transcription stays in the bar, and Retry re-sends it');
  stub.outcomes.push({ error: 'stub: the audio could not be decoded' });
  const beforeD = await value();
  const uploadsBeforeD = uploads.length;
  await dictate(2000);
  await waitPhase('failed');
  check('the bar shows the server message', /could not be decoded/.test(await page.textContent('#dictateStatus')),
    JSON.stringify(await page.textContent('#dictateStatus')));
  check('Retry and Discard offered in the bar',
    await page.isVisible('#dictateRetry') && (await page.textContent('#dictateCancel')) === 'Discard');
  check('nothing inserted on error', (await value()) === beforeD);
  check('launch buttons enabled while a failure is kept', await launchEnabled());
  check('mic enabled while a failure is kept', !(await micDisabled()));
  // Regression: Retry used to live only in a toast, which sat over the launch
  // buttons and vanished on any tap or newer toast.
  check('no toast over the launch buttons', !(await toastShown()));
  for (const [w, h] of [[390, 844], [375, 667]]) {
    await page.setViewportSize({ width: w, height: h });
    check(`launch buttons fully on screen and uncovered at ${w}x${h}`, await page.$$eval('.mode-btn', (bs) => bs.every((b) => {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.top >= 0 && r.bottom <= window.innerHeight && (hit === b || b.contains(hit));
    })));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => toast('Some unrelated error', 'err'));
  await page.click('#toast'); // a tap on a toast dismisses it
  check('another toast, and tapping it, leave Retry in place', await page.isVisible('#dictateRetry'));
  await page.click('#dictateRetry');
  await waitPhase('transcribing', 5000);
  await waitPhase('idle');
  const vD = await value();
  check('Retry transcribes and inserts', vD.split(STUB_TEXT).length - 1 === 2, JSON.stringify(vD));
  const [failedUpload, retriedUpload] = uploads.slice(uploadsBeforeD);
  check('Retry re-sent the same recording', uploads.length === uploadsBeforeD + 2
    && failedUpload.size > 0 && failedUpload.size === retriedUpload.size, JSON.stringify(uploads.slice(uploadsBeforeD)));
  check('bar hidden after the retry succeeded', !(await page.isVisible('#dictateBar')));

  // ---------- (d2) a new recording replaces a kept failure ----------
  console.log('\n(d2) a new recording replaces the kept failure');
  stub.outcomes.push({ error: 'stub: the audio could not be decoded' });
  await dictate(1500);
  await waitPhase('failed');
  await page.click('#micBtn');
  await waitPhase('recording');
  check('recording again leaves no Retry on screen', !(await page.isVisible('#dictateRetry')));
  await page.waitForTimeout(1500);
  await page.click('#micBtn');
  await waitPhase('idle');
  check('the new dictation inserts', (await value()).split(STUB_TEXT).length - 1 === 3);
  // And Discard drops a kept failure outright.
  stub.outcomes.push({ error: 'stub: the audio could not be decoded' });
  await dictate(1500);
  await waitPhase('failed');
  await page.click('#dictateCancel');
  check('Discard returns to idle and drops the clip',
    (await phase()) === 'idle' && (await page.evaluate(() => dict.blob === null && dict.retryKind === null)));

  // ---------- (d3) no Retry where a retry can only fail the same way ----------
  console.log('\n(d3) Retry only where it can help');
  // 0.2 s of audio: what a quick tap-tap on the mic uploads.
  const shortClip = (await readFile(clips.short)).toString('base64');
  const sendShort = () => page.evaluate((b64) => {
    dict.blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'audio/mp4' });
    uploadDictation();
  }, shortClip);
  const beforeD3 = await value();
  await sendShort();
  await waitPhase('transcribing', 5000);
  await waitPhase('idle');
  check('too short: a plain message and no Retry',
    /Too short/.test(await toastText()) && !(await page.isVisible('#dictateBar')), JSON.stringify(await toastText()));
  check('too short: the clip is dropped, nothing inserted',
    (await page.evaluate(() => dict.blob === null)) && (await value()) === beforeD3);
  for (const [label, reply, want, retry] of [
    ['503 (dictation off on the PC)', { status: 503, body: { error: 'no AssemblyAI key: set ASSEMBLYAI_API_KEY' } }, /unavailable on the PC: no AssemblyAI key/, false],
    ['413 (too large)', { status: 413, body: { error: 'audio is larger than 26214400 bytes' } }, /too large to send/, false],
    ['415', { status: 415, body: { error: 'content-type must be audio/*' } }, /refused/, false],
    ['429 (PC busy)', { status: 429, body: { error: 'too many transcriptions in progress' } }, /busy/, true],
    ['502', { status: 502, body: { error: 'bad gateway' } }, /Upload failed/, true],
    ['network error', { reject: 'Load failed' }, /Could not reach the PC \(Load failed\)/, true],
  ]) {
    await scriptNextFetch('/api/transcribe', reply);
    await sendShort();
    await waitPhase(retry ? 'failed' : 'idle');
    const msg = retry ? await page.textContent('#dictateStatus') : await toastText();
    check(`${label}: ${retry ? 'kept with Retry' : 'no Retry'}`, want.test(msg)
      && (await page.isVisible('#dictateRetry')) === retry, JSON.stringify(msg));
    if (retry) await page.click('#dictateCancel'); // Discard
  }

  // ---------- (e) a reload mid-transcription resumes the job ----------
  console.log('\n(e) reload while transcribing: the pending job is resumed, 15 min on');
  stub.outcomes.push({ hold: true });
  const heldBefore = stub.transcripts.size;
  await dictate(2000);
  await waitPhase('transcribing', 5000);
  const pendingSaved = await waitFor(() => stored(PENDING_KEY), { timeout: 10000 });
  check('pending job id saved in localStorage', !!pendingSaved, String(pendingSaved));
  check('job reached AssemblyAI and is held there',
    await waitFor(() => stub.transcripts.size === heldBefore + 1, { timeout: 10000 }));
  // As if iOS had killed the app and it was reopened a quarter of an hour later:
  // past the old 10-minute window, inside the server's 30.
  await page.evaluate((k) => {
    const p = JSON.parse(localStorage.getItem(k));
    p.startedAt = Date.now() - 15 * 60 * 1000;
    localStorage.setItem(k, JSON.stringify(p));
  }, PENDING_KEY);
  const beforeE = await value();
  await page.reload();
  await page.waitForSelector('.mode-btn');
  await waitPhase('transcribing', 5000).catch(() => {});
  check('after reload the page is still transcribing', (await phase()) === 'transcribing', await phase());
  check('launch buttons disabled while the resumed job runs', await launchDisabled());
  check('Cancel offered while transcribing', await page.isVisible('#dictateCancel'));
  stub.release();
  await waitPhase('idle');
  const vE = await value();
  check('resumed transcript appended to the restored draft', vE === `${beforeE} ${STUB_TEXT}`, JSON.stringify(vE));
  check('a notice says where the text came from', /Added a dictation from 15 min ago/.test(await toastText()),
    JSON.stringify(await toastText()));
  check('pending job id cleared after resume', (await stored(PENDING_KEY)) === null);
  check('launch buttons re-enabled after resume', await launchEnabled());

  // ---------- (e2) one too old to resume is reported, not dropped silently ----------
  console.log('\n(e2) a pending job past the resume window');
  await page.evaluate(([k, id]) => localStorage.setItem(k, JSON.stringify({ id, startedAt: Date.now() - 40 * 60 * 1000 })),
    [PENDING_KEY, randomUUID()]);
  const beforeE2 = await value();
  await page.reload();
  await load();
  await page.waitForTimeout(300);
  check('told the dictation expired', /from 40 min ago had expired/.test(await toastText()), JSON.stringify(await toastText()));
  check('idle, pending id removed, draft intact',
    (await phase()) === 'idle' && (await stored(PENDING_KEY)) === null && (await value()) === beforeE2);

  // ---------- (g) Cancel while transcribing: a hung poll is no trap ----------
  console.log('\n(g) a hung poll: Cancel frees the page and keeps the job for Retry');
  const hung = [];
  await page.route('**/api/transcribe/*', (route) => { hung.push(route); }); // never answered
  stub.outcomes.push({ hold: true });
  const heldG = stub.transcripts.size;
  await dictate(1500);
  await waitPhase('transcribing', 5000);
  check('poll hangs', await waitFor(() => hung.length > 0, { timeout: 10000 }));
  check('job reached AssemblyAI', await waitFor(() => stub.transcripts.size === heldG + 1, { timeout: 10000 }));
  check('Cancel shown while transcribing', (await page.isVisible('#dictateCancel'))
    && (await page.textContent('#dictateCancel')) === 'Cancel');
  const uploadsG = uploads.length;
  await page.click('#dictateCancel');
  check('Cancel stops waiting at once, keeping the job for Retry', (await phase()) === 'failed'
    && /Stopped waiting/.test(await page.textContent('#dictateStatus')) && (await page.isVisible('#dictateRetry')));
  check('launch and mic usable again', (await launchEnabled()) && !(await micDisabled()));
  check('the hung request was aborted', await page.evaluate(() => dict.inflight === null));
  check('a reload would not resume what was cancelled', (await stored(PENDING_KEY)) === null);
  await page.unroute('**/api/transcribe/*');
  for (const r of hung) await r.abort().catch(() => {}); // already aborted by the page
  await page.click('#dictateRetry');
  await waitPhase('transcribing', 5000);
  check('waiting again is resumable after a reload again',
    JSON.parse((await stored(PENDING_KEY)) || '{}').id === (await page.evaluate(() => dict.jobId)));
  stub.release();
  await waitPhase('idle');
  check('Retry waited on the same job instead of uploading again',
    uploads.length === uploadsG && stub.transcripts.size === heldG + 1, `${uploads.length - uploadsG} uploads`);
  check('its text is inserted', (await value()).endsWith(STUB_TEXT), JSON.stringify(await value()));

  // ---------- (h) a failed poll after a long suspend ----------
  console.log('\n(h) the first poll after a long suspend fails');
  stub.outcomes.push({ hold: true });
  const heldH = stub.transcripts.size;
  await dictate(1500);
  await waitPhase('transcribing', 5000);
  check('job reached AssemblyAI', await waitFor(() => stub.transcripts.size === heldH + 1, { timeout: 10000 }));
  // The page was frozen past the 4-minute deadline; the first request after it
  // fails because the network isn't back yet. Set up in one task, so no regular
  // poll can slip in between.
  await page.evaluate(async () => {
    while (dict.inflight) await new Promise((r) => setTimeout(r, 10));
    const real = window.fetch;
    window.fetch = () => { window.fetch = real; return Promise.reject(new TypeError('Load failed')); };
    dict.pollDeadline = Date.now() - 1000;
    schedulePoll(0);
  });
  await waitFor(() => page.evaluate(() => dict.pollErrors > 0 || dict.phase !== 'transcribing'), { timeout: 5000 });
  check('one failed poll does not end the dictation', (await phase()) === 'transcribing',
    `${await phase()}: ${await page.textContent('#dictateStatus')}`);
  stub.release();
  await waitPhase('idle');
  check('the transcript still lands', (await value()).endsWith(STUB_TEXT));
  // Coming back to the page gives a stale deadline a fresh minute.
  const extended = await page.evaluate(() => {
    const saved = [dict.phase, dict.jobId, dict.pollDeadline];
    dict.phase = 'transcribing';
    dict.jobId = 'not-a-job';
    dict.pollDeadline = Date.now() - 1000;
    document.dispatchEvent(new Event('visibilitychange'));
    const ok = dict.pollDeadline > Date.now() + 50 * 1000;
    clearTimeout(dict.pollTimer);
    [dict.phase, dict.jobId, dict.pollDeadline] = saved;
    return ok;
  });
  check('visibilitychange extends a deadline that ran on while frozen', extended);

  // ---------- (i) a kept 'poll' failure and a new recording ----------
  console.log('\n(i) a new recording drops the old job\'s pending id');
  stub.outcomes.push({ hold: true });
  await dictate(1500);
  await waitPhase('transcribing', 5000);
  await waitFor(() => stored(PENDING_KEY), { timeout: 10000 });
  await page.evaluate(async () => {
    while (dict.inflight) await new Promise((r) => setTimeout(r, 10));
    const real = window.fetch;
    window.fetch = () => { window.fetch = real; return Promise.reject(new TypeError('Load failed')); };
    dict.pollErrors = POLL_MAX_ERRORS - 1;
    schedulePoll(0);
  });
  await waitPhase('failed', 5000);
  check('lost contact: kept for Retry, pending id kept for a reload',
    /Lost contact/.test(await page.textContent('#dictateStatus')) && !!(await stored(PENDING_KEY)));
  await page.click('#micBtn');
  await waitPhase('recording');
  check('a new recording removes the old pending id', (await stored(PENDING_KEY)) === null);
  await page.click('#dictateCancel');
  check('cancel leaves nothing to resume', (await phase()) === 'idle' && (await stored(PENDING_KEY)) === null);
  stub.release();

  // ---------- (k) an old cached index.html next to this app.js ----------
  console.log('\n(k) old HTML with the new script still launches');
  const html = await (await fetch(BASE + '/index.html')).text();
  const variants = {
    'pre-dictation HTML': html.replace(/<button id="micBtn"[\s\S]*?<\/button>/, '').replace(/<div id="dictateBar"[\s\S]*?<\/div>/, ''),
    'first dictation release (no Retry button)': html.replace(/<button id="dictateRetry"[\s\S]*?<\/button>/, ''),
  };
  for (const [label, body] of Object.entries(variants)) {
    // Service workers blocked: a route can't see what a worker fetches.
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    await ctx.route('**/api/launch', (route) => { launchCalls++; route.abort(); });
    await ctx.route(BASE + '/', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }));
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE + '/');
    await p.waitForSelector('.mode-btn', { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(300);
    const modes = await p.$$eval('.mode-btn', (bs) => bs.map((b) => !b.disabled));
    const errToast = await p.$eval('#toast', (t) => !t.classList.contains('hidden') && t.className.includes('err'));
    check(`${label}: loads with working launch buttons, no errors`,
      errs.length === 0 && modes.length === 2 && modes.every(Boolean) && !errToast, JSON.stringify({ errs, modes, errToast }));
    await ctx.close();
  }

  // ---------- (f) and the run as a whole ----------
  console.log('\n(f) whole run');
  check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors));
  check('/api/launch never called', launchCalls === 0, `${launchCalls} calls`);
  check('no dictation temp dirs left on the server', await waitFor(async () => (await server.tempDirs()).length === 0, { timeout: 3000 }));
  check('server log holds neither the key nor the transcript',
    !server.log.includes(ENV_KEY) && !server.log.includes(STUB_TEXT), server.log.slice(-500));
} catch (e) {
  failures++;
  console.log(`  FAIL  ${e.stack || e}`);
} finally {
  clearTimeout(watchdog);
  await cleanup();
}

console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
