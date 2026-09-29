'use strict';

const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `HTTP ${r.status}`);
    e.status = r.status; // lets callers tell "job gone" (404) from a network blip
    throw e;
  }
  return data;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// localStorage throws in some private modes and when the quota is full. Nothing
// kept there is worth breaking the app over, so every access is best-effort.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* best effort */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* best effort */ } },
};

const state = {
  dir: '~',
  modes: [],
  models: [],
  model: null,
  favorites: [],
  browseDir: '~',
  launching: false,
};

// ---------- toast ----------
// `msg` is HTML: callers must esc() anything dynamic. A toast is for news, never
// for the only way to act on something: it sits over the launch buttons, and a
// tap or the next toast takes it down (dictation's Retry lives in its own bar).
let toastTimer;
let toastSeq = 0; // identifies the toast on screen (see dict.failToast)
function toast(msg, kind = '') {
  const t = $('toast');
  t.className = 'toast ' + kind;
  t.innerHTML = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'err' ? 6000 : 4500);
  return ++toastSeq;
}

// ---------- directory selection ----------
function setDir(path) {
  state.dir = path;
  $('selectedDir').textContent = path;
  // reflect active favorite chip
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.path === path));
}

function renderFavorites() {
  const wrap = $('favorites');
  wrap.innerHTML = '';
  for (const f of state.favorites) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = f.label;
    b.dataset.path = f.path;
    b.addEventListener('click', () => { setDir(f.path); clearResults(); });
    wrap.appendChild(b);
  }
}

function renderResults(dirs) {
  const ul = $('dirResults');
  ul.innerHTML = '';
  for (const d of dirs) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = d.label;
    const src = document.createElement('span');
    src.className = 'src ' + (d.source || '');
    src.textContent = d.source === 'frecent' ? 'frecent' : d.source === 'filesystem' ? 'fs' : d.source || '';
    li.appendChild(label);
    li.appendChild(src);
    li.addEventListener('click', () => { setDir(d.label); clearResults(); });
    ul.appendChild(li);
  }
}

let searchTimer;
let searchSeq = 0;
function clearResults() {
  searchSeq++; // invalidate any in-flight search so it can't repopulate
  $('dirResults').innerHTML = '';
  $('dirSearch').value = '';
}
function onSearch() {
  const q = $('dirSearch').value.trim();
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  if (!q) { $('dirResults').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const { dirs } = await api('/api/dirs?q=' + encodeURIComponent(q));
      if (seq !== searchSeq) return; // a newer query (or clear) superseded this one
      renderResults(dirs);
    } catch (e) { if (seq === searchSeq) toast(esc(e.message), 'err'); }
  }, 180);
}

// ---------- browse modal ----------
async function openBrowse(path) {
  try {
    const data = await api('/api/browse?path=' + encodeURIComponent(path || state.dir || '~'));
    state.browseDir = data.path;
    state.browseLabel = data.label;
    $('browsePath').textContent = data.label;
    $('browseUp').style.visibility = data.parent ? 'visible' : 'hidden';
    $('browseUp').dataset.path = data.parent || '';
    const ul = $('browseList');
    ul.innerHTML = '';
    if (!data.dirs.length) {
      const li = document.createElement('li');
      li.textContent = '(no subfolders)';
      li.style.color = 'var(--muted)';
      ul.appendChild(li);
    }
    for (const d of data.dirs) {
      const li = document.createElement('li');
      li.textContent = '📁 ' + d.name;
      li.addEventListener('click', () => openBrowse(d.path));
      ul.appendChild(li);
    }
    $('browseModal').classList.remove('hidden');
  } catch (e) { toast(esc(e.message), 'err'); }
}

// ---------- sessions modal ----------
async function refreshSessions() {
  try {
    const { sessions } = await api('/api/sessions');
    $('sessionsCount').textContent = sessions.length;
    return sessions;
  } catch { return []; }
}
async function openSessions() {
  const sessions = await refreshSessions();
  const ul = $('sessionsList');
  ul.innerHTML = '';
  if (!sessions.length) {
    const li = document.createElement('li');
    li.textContent = '(no running sessions)';
    li.style.color = 'var(--muted)';
    ul.appendChild(li);
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot' + (s.attached ? ' on' : '');
    const name = document.createElement('span');
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = s.cwd;
    li.appendChild(dot);
    li.appendChild(name);
    li.appendChild(meta);
    ul.appendChild(li);
  }
  $('sessionsModal').classList.remove('hidden');
}

// ---------- launch ----------
// The single place that decides whether the launch buttons and the mic can be
// pressed. launch() and dictation each only flip their own flag and call this,
// so a launch finishing can never re-enable buttons a pending transcript still
// needs disabled (and vice versa).
function syncControls() {
  document.querySelectorAll('.mode-btn').forEach((b) => (b.disabled = state.launching || dictationBusy()));
  // Looked up, not assumed: an old cached index.html served next to this script
  // has no dictation controls, and the launcher must still work there.
  const mic = $('micBtn');
  // While recording the mic button IS the stop button, so it stays live then.
  if (mic) mic.disabled = state.launching || dict.phase === 'starting' || dict.phase === 'transcribing';
  // A launch that succeeds discards the kept dictation, so Retry waits for it.
  const retry = $('dictateRetry');
  if (retry) retry.disabled = state.launching;
}

async function launch(mode) {
  // The buttons are disabled in both cases; this guards a tap that raced the render.
  if (state.launching || dictationBusy()) return;
  state.launching = true;
  syncControls();
  try {
    const body = {
      dir: state.dir,
      name: $('sessionName').value.trim(),
      prompt: $('prompt').value,
      mode,
      model: state.model,
    };
    const r = await api('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const modelTag = r.model ? ` · ${esc(r.model)}` : '';
    toast(`Started <code>${esc(r.session)}</code> · ${esc(r.label)}${modelTag} in <code>${esc(r.dir)}</code>.<br>Open the Claude app → it appears under remote sessions.`, 'ok');
    $('prompt').value = '';
    promptCleared();
    // That prompt is gone: a dictation kept for it (or its pending id, after a
    // reload) must not turn up in the next one.
    discardDictation();
    refreshSessions();
  } catch (e) {
    toast(esc(e.message), 'err');
  } finally {
    state.launching = false;
    syncControls();
  }
}

function renderModes() {
  const wrap = $('modeButtons');
  wrap.innerHTML = '';
  for (const m of state.modes) {
    const b = document.createElement('button');
    b.className = 'mode-btn';
    b.dataset.mode = m.id;
    b.innerHTML = `${m.label}${m.subtitle ? `<small>${m.subtitle}</small>` : ''}`;
    b.addEventListener('click', () => launch(m.id));
    wrap.appendChild(b);
  }
  syncControls(); // fresh buttons start enabled; a resumed transcript may say otherwise
}

function setModel(id) {
  state.model = id;
  document.querySelectorAll('#modelSelect button').forEach((b) => b.classList.toggle('active', b.dataset.model === id));
}

function renderModels() {
  const field = $('modelField');
  const wrap = $('modelSelect');
  wrap.innerHTML = '';
  field.hidden = state.models.length === 0;
  for (const m of state.models) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.model = m.id;
    b.textContent = m.label;
    b.addEventListener('click', () => setModel(m.id));
    wrap.appendChild(b);
  }
  setModel(state.models[0] ? state.models[0].id : null);
}

// ---------- prompt draft + caret ----------
// The prompt survives a reload or iOS killing the backgrounded app: a dictated
// paragraph is exactly the text nobody wants to say twice.
const DRAFT_KEY = 'claude-launcher.draft';
let draftTimer = null;
function saveDraftNow() {
  clearTimeout(draftTimer);
  draftTimer = null;
  const v = $('prompt').value;
  if (v) store.set(DRAFT_KEY, v); else store.remove(DRAFT_KEY);
}
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 400);
}
function restoreDraft() {
  const v = store.get(DRAFT_KEY);
  if (v && !$('prompt').value) $('prompt').value = v;
}

// Where a transcript lands. Tapping the mic blurs the textarea on iOS, and by the
// time the text comes back focus is long gone, so the selection is remembered as
// the user moves it rather than read at insert time. null = never placed.
const caret = { start: null, end: null };
function rememberCaret() {
  const ta = $('prompt');
  caret.start = ta.selectionStart;
  caret.end = ta.selectionEnd;
}
function promptCleared() {
  caret.start = caret.end = null;
  saveDraftNow(); // empty value -> removes the draft
}

// Replaces the remembered selection (or appends when there is none, it no longer
// fits the text, or `atEnd`), with one space against a neighbouring word and
// nothing added at the edges or next to existing whitespace/newlines.
function insertTranscript(text, atEnd) {
  const ta = $('prompt');
  const v = ta.value;
  let start = v.length;
  let end = v.length;
  if (!atEnd && caret.start !== null && caret.end !== null && caret.start <= caret.end && caret.end <= v.length) {
    start = caret.start;
    end = caret.end;
  }
  const before = v.slice(0, start);
  const after = v.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  ta.value = before + lead + text + trail + after;
  const pos = before.length + lead.length + text.length;
  // setSelectionRange but never focus(): focusing would raise the iOS keyboard
  // straight over the text that was just inserted.
  try { ta.setSelectionRange(pos, pos); } catch { /* cosmetic only */ }
  caret.start = caret.end = pos;
  if (!after) ta.scrollTop = ta.scrollHeight; // appended: show it
  saveDraftNow();
}

// ---------- dictation ----------
// Phone records -> POST /api/transcribe -> the PC transcribes (AssemblyAI) ->
// poll GET /api/transcribe/<id> -> text inserted at the caret. The audio stays
// in memory until its transcript lands so Retry re-sends the same clip; only the
// job id is persisted, so a reload can pick the result up.
//
// The iOS lessons come from ../audiorecorder (an hour-long room recorder); the
// numbers here are scaled down for a dictation of seconds to a few minutes.

// Short timeslice: a dictation is short, and chunks are the only liveness
// signal the stall watchdog trusts.
const TIMESLICE_MS = 1000;
// iOS can leave a track reporting live and unmuted while it produces nothing, so
// "no chunk for four timeslices" is the honest test that capture has died.
const STALL_AFTER_MS = TIMESLICE_MS * 4;
// The first chunk also carries encoder start-up and the MP4 init segment, so it
// gets longer before it counts as a stall (a false stop would cut the user off).
const FIRST_CHUNK_GRACE_MS = 8000;
// iOS has been seen never to fire the recorder's 'stop'. Waiting forever would
// keep the mic held and the UI stuck; a timeout costs at most the last second.
const STOP_WAIT_MS = 3000;
const POLL_MS = 1000;
const POLL_DEADLINE_MS = 4 * 60 * 1000;
// A poll answer is a few hundred bytes. One taking longer is a dead connection
// (after a suspend iOS can hold one open indefinitely), and while it hangs no
// other poll runs, so it has to end as an ordinary failed tick.
const POLL_TIMEOUT_MS = 15 * 1000;
// Consecutive failed polls (PC unreachable) before giving up — with the backoff
// below about 40 s when each fails fast, at most about 3 min when each hangs until
// POLL_TIMEOUT_MS. The job keeps running on the PC, so Retry and a reload both
// resume polling the same id instead of uploading again.
const POLL_MAX_ERRORS = 10;
const PENDING_KEY = 'claude-launcher.dictation';
// A reload resumes a job up to this long after upload. The server keeps a job
// until 30 min after it finished, which is after the upload, so the result is
// still there; past this the user is told rather than silently left without it.
const RESUME_MAX_AGE_MS = 30 * 60 * 1000;
// Left unset, WebKit records 48 kHz AAC at 192 kbit/s. 64 kbit/s is plenty for
// speech and a third of the upload over the tailnet.
const AUDIO_BITS_PER_SECOND = 64000;

/*
 * Voice processing ON — the opposite of audiorecorder, which records a room with
 * echoCancellation:false. Dictation is one close voice, which is exactly what the
 * voice-call chain is tuned for: it evens out the level (so a quiet aside and a
 * loud word both transcribe) and suppresses fan/street noise. On iOS the one
 * constraint WebKit honours is echoCancellation, and true keeps its voice
 * processing unit (gain control + noise suppression included) in the path;
 * the other two are listed for Chrome/Android, and WebKit silently ignores them.
 */
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

const dict = {
  enabled: false,
  maxSeconds: 600,
  // failed = an attempt ended but its clip or job is kept for Retry; nothing is in
  // flight, so it blocks nothing (see dictationBusy).
  phase: 'idle', // idle | starting | recording | transcribing | failed
  // Bumped when a recording starts or is cancelled, so async continuations
  // (getUserMedia, chunks, the stop wait, the upload and polls) can tell they
  // belong to a dead attempt.
  gen: 0,
  stream: null,
  recorder: null,
  chunks: [],
  audioCtx: null,
  analyser: null,
  levelRaf: null,
  ticker: null,
  stallTimer: null,
  limitTimer: null,
  wakeLock: null,
  startedAt: 0,
  lastChunkAt: 0,
  gotChunk: false,
  blob: null, // kept until its transcript lands, so Retry re-sends the same audio
  jobId: null,
  jobStartedAt: 0, // upload time of jobId; the pending entry's age counts from it
  retryKind: null, // in 'failed': 'upload' re-sends the blob, 'poll' waits on jobId again
  appendOnly: false, // a resumed job's caret belonged to the previous page life
  resumedFrom: 0, // upload time of a job picked up after a reload, for the notice
  inflight: null, // AbortController of the upload or poll in flight, for Cancel
  pollTimer: null,
  pollDeadline: 0,
  pollErrors: 0,
  failToast: 0, // toastSeq of the last dictation error, which a new recording makes stale
};

const STATUS_TEXT = { starting: 'Starting microphone…', recording: 'Recording', transcribing: 'Transcribing…' };
// The same button ends an attempt, or in 'failed' drops the dictation kept there.
const CANCEL_TEXT = { failed: 'Discard' };

// True while something is actually happening: the launch buttons wait for it.
function dictationBusy() {
  return dict.phase === 'starting' || dict.phase === 'recording' || dict.phase === 'transcribing';
}

// `status` overrides the phase's own label ('failed' shows what went wrong).
function setPhase(phase, status) {
  dict.phase = phase;
  $('promptField').dataset.dictation = phase;
  // Constant label + aria-pressed is the toggle-button pattern: "Dictate prompt,
  // pressed" while recording, and pressing it again stops.
  $('micBtn').setAttribute('aria-pressed', phase === 'recording' ? 'true' : 'false');
  $('dictateBar').hidden = phase === 'idle';
  $('dictateStatus').textContent = status || STATUS_TEXT[phase] || '';
  $('dictateCancel').textContent = CANCEL_TEXT[phase] || 'Cancel';
  if (phase !== 'recording') $('dictateElapsed').textContent = '0:00';
  syncControls();
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function micErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. On iPhone re-enable it in Settings → Safari → Microphone '
      + '(or aA → Website Settings in a Safari tab); on desktop use the site settings next to the address bar. Then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is busy — another app is using it.';
  return `Could not open the microphone: ${name || err}`;
}

// iOS only lets resume() succeed inside a user gesture, and it hands back a
// suspended context. So this runs in the tap itself, before getUserMedia's await.
function openAudioContext() {
  // Bracket access for the legacy name: only pre-14.1 Safari ever needed it.
  const Ctx = window.AudioContext || window['webkitAudioContext'];
  if (!Ctx) return null;
  try {
    const ctx = new Ctx();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}
function closeAudioContext(ctx) {
  if (ctx) ctx.close().catch(() => {});
}

function makeRecorder(stream) {
  // MP4/AAC first: it is what iOS produces and what ffmpeg on the PC reads most
  // reliably. Current Chrome takes plain audio/mp4 and records Opus in it; WebM is
  // for Firefox and older Chrome, which can't record MP4 at all.
  const candidates = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  const options = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
  if (MediaRecorder.isTypeSupported) {
    for (const mimeType of candidates) {
      if (MediaRecorder.isTypeSupported(mimeType)) return new MediaRecorder(stream, { ...options, mimeType });
    }
  }
  return new MediaRecorder(stream, options); // nothing matched: the browser's default
}

// The server only accepts audio/* — that is what keeps the upload a non-simple
// request a cross-origin page can't send. Some engines label an audio-only
// recording video/…; the bytes are the same, so relabel rather than fail.
function uploadType(blob) {
  const t = blob.type || 'audio/mp4';
  if (/^audio\//i.test(t)) return t;
  const m = /^video\/(.+)$/i.exec(t);
  return m ? 'audio/' + m[1] : 'audio/mp4';
}

async function startDictation() {
  if (dictationBusy() || state.launching) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // navigator.mediaDevices is undefined outside a secure context.
    toast('The microphone only works on a secure page. Open the launcher through its Tailscale <code>https://</code> URL, not an IP address or <code>http://</code>.', 'err');
    return;
  }
  if (typeof MediaRecorder === 'undefined') {
    toast('This browser cannot record audio (no MediaRecorder).', 'err');
    return;
  }

  const gen = ++dict.gen;
  // A new recording supersedes one kept after a failure, pending id included: a
  // reload must not bring the old text back into whatever gets typed next.
  discardDictation();
  // A failure toast still up would read as if the new dictation had failed too.
  if (dict.failToast === toastSeq) $('toast').classList.add('hidden');
  // Everything up to getUserMedia runs synchronously in the tap: iOS ties both
  // the permission prompt and AudioContext.resume() to the user gesture.
  const ctx = openAudioContext();
  setPhase('starting');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
  } catch (err) {
    closeAudioContext(ctx);
    if (gen !== dict.gen) return; // cancelled while the permission prompt was up
    setPhase('idle');
    toast(esc(micErrorMessage(err)), 'err');
    return;
  }
  if (gen !== dict.gen) { // Cancel was tapped while the mic was opening
    stream.getTracks().forEach((t) => t.stop());
    closeAudioContext(ctx);
    return;
  }

  let recorder;
  try {
    recorder = makeRecorder(stream);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    closeAudioContext(ctx);
    setPhase('idle');
    toast('Could not start recording: ' + esc(err.message || err), 'err');
    return;
  }

  dict.stream = stream;
  dict.recorder = recorder;
  dict.chunks = [];
  dict.audioCtx = ctx;
  dict.gotChunk = false;
  recorder.ondataavailable = (e) => {
    // Empty chunks don't count as liveness: a stalled iOS recorder can keep
    // firing the event with nothing in it.
    if (gen !== dict.gen || !e.data || !e.data.size) return;
    dict.chunks.push(e.data);
    dict.lastChunkAt = Date.now();
    dict.gotChunk = true;
  };
  recorder.onerror = (e) => {
    if (gen !== dict.gen || dict.phase !== 'recording') return;
    toast('Recording stopped: ' + esc((e && e.error && e.error.name) || 'unknown error') + '. Transcribing what was captured.', 'err');
    finishRecording();
  };
  // The recorder can also stop by itself (track ended, interruption). Treat that
  // like a Stop tap and transcribe what was captured.
  recorder.addEventListener('stop', () => {
    if (gen === dict.gen && dict.phase === 'recording') finishRecording();
  });
  try {
    recorder.start(TIMESLICE_MS);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    closeAudioContext(ctx);
    dict.stream = dict.recorder = dict.audioCtx = null;
    setPhase('idle');
    toast('Could not start recording: ' + esc(err.message || err), 'err');
    return;
  }

  dict.startedAt = dict.lastChunkAt = Date.now();
  setPhase('recording');
  startTicker();
  startStallWatchdog(gen);
  startLevelMeter(ctx, stream);
  acquireWakeLock();
  watchTrack(stream, gen);
  dict.limitTimer = setTimeout(() => {
    if (gen !== dict.gen || dict.phase !== 'recording') return;
    toast(`Reached the ${fmtClock(dict.maxSeconds * 1000)} limit — transcribing what was recorded.`);
    finishRecording();
  }, dict.maxSeconds * 1000);
}

// Tears down everything a recording holds and returns the audio (null when
// discarded or empty). Always ends with every track stopped: a live track is
// what keeps the iOS microphone indicator on.
async function stopCapture(discard) {
  const { recorder, stream, chunks } = dict;
  clearInterval(dict.ticker);
  clearInterval(dict.stallTimer);
  clearTimeout(dict.limitTimer);
  dict.ticker = dict.stallTimer = dict.limitTimer = null;
  stopLevelMeter();
  releaseWakeLock();
  if (recorder && recorder.state !== 'inactive') {
    if (discard) {
      recorder.ondataavailable = null;
      try { recorder.stop(); } catch { /* already stopping */ }
    } else {
      // stop() flushes one final dataavailable before 'stop'; bounded, see STOP_WAIT_MS.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, STOP_WAIT_MS);
        recorder.addEventListener('stop', () => { clearTimeout(timer); resolve(); }, { once: true });
        try { recorder.stop(); } catch { clearTimeout(timer); resolve(); }
      });
    }
  }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  const type = (recorder && recorder.mimeType) || (chunks[0] && chunks[0].type) || 'audio/mp4';
  // Cancel during the flush above ends the attempt, and a new recording may have
  // started meanwhile: its recorder and chunks are not this one's to clear.
  if (dict.recorder === recorder) {
    dict.recorder = dict.stream = null;
    dict.chunks = [];
  }
  if (discard || !chunks.length) return null;
  return new Blob(chunks, { type });
}

async function finishRecording() {
  if (dict.phase !== 'recording') return;
  const gen = dict.gen;
  setPhase('transcribing'); // spinner at once; the recorder flush can take a moment
  const blob = await stopCapture(false);
  if (gen !== dict.gen) return;
  if (!blob || !blob.size) {
    setPhase('idle');
    toast('Nothing was recorded — the microphone produced no audio.', 'err');
    return;
  }
  dict.blob = blob;
  uploadDictation();
}

// While recording, Cancel discards the clip. While transcribing it only stops the
// waiting: launch is free again at once, and the clip (or the job still running
// on the PC) stays in the bar for Retry, so a stuck upload or a slow transcript
// never costs a dictated paragraph. In 'failed' the button is Discard.
function cancelDictation() {
  if (dict.phase === 'recording' || dict.phase === 'starting') {
    dict.gen++; // a pending getUserMedia or late chunk now knows it is stale
    stopCapture(true); // the discard path never awaits, so teardown is done on return
    setPhase('idle');
  } else if (dict.phase === 'transcribing') {
    dict.gen++; // the recorder flush, upload or poll in flight now knows it is stale
    abortDictationRequest();
    clearTimeout(dict.pollTimer);
    dict.pollTimer = null;
    // Kept in memory for Retry, but a reload must not resume what the user stopped.
    store.remove(PENDING_KEY);
    const kind = dict.jobId ? 'poll' : dict.blob ? 'upload' : null;
    // No kind = still flushing the recorder, so there is nothing to keep yet.
    if (kind) keepForRetry('Stopped waiting for the transcript.', kind); else setPhase('idle');
  } else if (dict.phase === 'failed') {
    discardDictation();
  }
}

function watchTrack(stream, gen) {
  const [track] = stream.getAudioTracks();
  if (!track) return;
  // 'mute' can be transient (a call, Siri), so it only warns; if capture really
  // is gone the stall watchdog stops within a few seconds.
  track.addEventListener('mute', () => {
    if (gen === dict.gen && dict.phase === 'recording') {
      toast('Microphone interrupted. If it doesn’t come back, what was said so far gets transcribed.', 'err');
    }
  });
  track.addEventListener('ended', () => {
    if (gen === dict.gen && dict.phase === 'recording') {
      toast('The microphone was taken away — transcribing what was captured.', 'err');
      finishRecording();
    }
  });
}

// Watch data flow, not the track's opinion of itself (see STALL_AFTER_MS).
// Stopping transcribes what did arrive, which beats a timer counting over silence.
function startStallWatchdog(gen) {
  dict.stallTimer = setInterval(() => {
    if (gen !== dict.gen || dict.phase !== 'recording') return;
    const since = Date.now() - dict.lastChunkAt;
    if (since < (dict.gotChunk ? STALL_AFTER_MS : FIRST_CHUNK_GRACE_MS)) return;
    toast(`The microphone stopped producing audio ${Math.round(since / 1000)}s ago (iOS may have suspended it). Transcribing what was captured.`, 'err');
    finishRecording();
  }, 1000);
}

function startTicker() {
  // Recomputed from the start time rather than accumulated, so throttled timers
  // in the background can't make the clock drift.
  const tick = () => { $('dictateElapsed').textContent = fmtClock(Date.now() - dict.startedAt); };
  tick();
  dict.ticker = setInterval(tick, 250);
}

function startLevelMeter(ctx, stream) {
  if (!ctx) return;
  try {
    // getUserMedia can re-route the iOS audio session and interrupt a context
    // that was already resumed; asking again is harmless.
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    dict.analyser = analyser;
    const buf = new Uint8Array(analyser.fftSize);
    const bar = $('dictateLevel');
    const tick = () => {
      if (dict.analyser !== analyser) return;
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      // sqrt compresses the top of the range so normal speech uses most of the bar.
      bar.style.transform = `scaleX(${Math.min(1, Math.sqrt(peak) * 1.3).toFixed(3)})`;
      dict.levelRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    dict.analyser = null; // no meter is fine; the recording doesn't depend on it
  }
}

function stopLevelMeter() {
  if (dict.levelRaf) cancelAnimationFrame(dict.levelRaf);
  dict.levelRaf = null;
  dict.analyser = null;
  $('dictateLevel').style.transform = 'scaleX(0)';
  closeAudioContext(dict.audioCtx);
  dict.audioCtx = null;
}

// Keeps the screen on while recording: in an installed PWA iOS stops the mic
// when the screen locks. The lock is dropped whenever the page is hidden, so the
// visibilitychange handler re-requests it. A granted lock is not a guarantee
// (some iOS versions returned one and slept anyway) — the stall watchdog is.
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (dict.wakeLock && !dict.wakeLock.released) return;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    if (dict.phase !== 'recording') { sentinel.release().catch(() => {}); return; } // stopped meanwhile
    dict.wakeLock = sentinel;
    sentinel.addEventListener('release', () => { if (dict.wakeLock === sentinel) dict.wakeLock = null; });
  } catch { /* denied or unsupported: recording still works with the screen on */ }
}
function releaseWakeLock() {
  if (dict.wakeLock) dict.wakeLock.release().catch(() => {});
  dict.wakeLock = null;
}

// ---------- dictation: upload + poll ----------
// api() with an AbortController Cancel can reach, and an optional timeout. The
// phase allows one dictation request at a time, so one slot is enough.
async function dictationRequest(path, opts, timeoutMs) {
  const ctl = new AbortController();
  dict.inflight = ctl;
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs) : null;
  try {
    return await api(path, { ...opts, signal: ctl.signal });
  } catch (e) {
    // An abort only says "aborted"; that it was the timeout is the useful part.
    throw timedOut ? new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`) : e;
  } finally {
    clearTimeout(timer);
    if (dict.inflight === ctl) dict.inflight = null;
  }
}
function abortDictationRequest() {
  if (dict.inflight) dict.inflight.abort();
  dict.inflight = null;
}

async function uploadDictation() {
  const blob = dict.blob;
  if (!blob) return;
  const gen = dict.gen;
  setPhase('transcribing');
  let job;
  try {
    // No timeout: a long clip over a weak uplink can take minutes, and Cancel
    // keeps the clip for Retry, so a stuck upload is never a trap.
    job = await dictationRequest('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': uploadType(blob) },
      body: blob,
    });
  } catch (e) {
    if (gen !== dict.gen || dict.blob !== blob) return;
    uploadFailed(e);
    return;
  }
  if (gen !== dict.gen || dict.blob !== blob) return;
  if (!job.id) { dictationFailed('The PC did not return a transcription id.', 'upload'); return; }
  dict.jobId = job.id;
  dict.jobStartedAt = Date.now();
  dict.appendOnly = false;
  dict.resumedFrom = 0;
  savePending();
  startPolling();
}

// What a reload needs to pick the job back up (see resumePendingDictation).
function savePending() {
  store.set(PENDING_KEY, JSON.stringify({ id: dict.jobId, startedAt: dict.jobStartedAt }));
}

// Retry only where a second attempt can get past the failure: the network, a busy
// PC (429) or a server error. A clip the PC refused (413, 415, any other 4xx) or
// dictation being off (503: no key, no ffmpeg) would be refused again.
function uploadFailed(e) {
  const s = e.status;
  if (!s) dictationFailed(`Could not reach the PC (${e.message}).`, 'upload');
  else if (s === 429) dictationFailed('The PC is busy with other transcriptions — retry in a moment.', 'upload');
  else if (s === 503) dictationFailed(`Dictation is unavailable on the PC: ${e.message}`, null);
  else if (s === 413) dictationFailed(`The recording is too large to send (${e.message}).`, null);
  else if (s >= 500 || s === 408) dictationFailed(`Upload failed: ${e.message}`, 'upload');
  else dictationFailed(`Upload refused: ${e.message}`, null);
}

function startPolling() {
  dict.pollDeadline = Date.now() + POLL_DEADLINE_MS;
  dict.pollErrors = 0;
  setPhase('transcribing');
  schedulePoll(0);
}
function schedulePoll(delay) {
  clearTimeout(dict.pollTimer);
  dict.pollTimer = setTimeout(pollJob, delay);
}

async function pollJob() {
  dict.pollTimer = null;
  // One request at a time: a visibility-triggered poll must not overlap one in
  // flight, which reschedules itself when it settles (POLL_TIMEOUT_MS bounds that).
  if (dict.phase !== 'transcribing' || !dict.jobId || dict.inflight) return;
  const id = dict.jobId;
  const gen = dict.gen;
  let job = null;
  let err = null;
  try {
    job = await dictationRequest('/api/transcribe/' + encodeURIComponent(id), { cache: 'no-store' }, POLL_TIMEOUT_MS);
  } catch (e) {
    err = e;
  }
  if (gen !== dict.gen || id !== dict.jobId || dict.phase !== 'transcribing') return;

  if (err) {
    if (err.status === 404) {
      store.remove(PENDING_KEY);
      dictationFailed('The PC no longer has this transcription (it may have restarted).', 'upload');
      return;
    }
    if (++dict.pollErrors >= POLL_MAX_ERRORS) {
      dictationFailed(`Lost contact with the PC while transcribing (${err.message}).`, 'poll');
      return;
    }
    // Not held to the deadline: the first request after a long suspend often fails
    // before the network is back, and a deadline that ran on while the page was
    // frozen would turn that one blip into "stopped waiting". POLL_MAX_ERRORS
    // already bounds an unreachable PC.
    schedulePoll(Math.min(POLL_MS * 2 ** dict.pollErrors, 5000));
    return;
  }
  if (job.status === 'done') {
    store.remove(PENDING_KEY);
    const text = String(job.text || '').trim();
    const atEnd = dict.appendOnly;
    const resumedFrom = dict.resumedFrom;
    dict.blob = null;
    dict.jobId = null;
    dict.resumedFrom = 0;
    setPhase('idle');
    if (!text) toast('No speech detected.');
    else {
      insertTranscript(text, atEnd);
      // Text from a previous page life appears with nothing on screen having
      // asked for it; say where it came from.
      if (resumedFrom) {
        const mins = Math.round((Date.now() - resumedFrom) / 60000);
        toast(`Added a dictation${mins >= 1 ? ` from ${mins} min ago` : ''} at the end of the prompt.`, 'ok');
      }
    }
    return;
  }
  if (job.status === 'error') {
    store.remove(PENDING_KEY);
    // retryable:false = the same clip would fail the same way (too short, too long).
    const retry = job.retryable === false ? null : 'upload';
    dictationFailed(job.code === 'no_audio'
      ? 'Too short — there was nothing to transcribe. Record a little longer before you tap stop.'
      : `Transcription failed: ${job.error || 'unknown error'}`, retry);
    return;
  }
  dict.pollErrors = 0; // still processing
  if (Date.now() > dict.pollDeadline) {
    dictationFailed('Still transcribing after 4 minutes — stopped waiting.', 'poll');
    return;
  }
  schedulePoll(POLL_MS);
}

// retry: 'upload' re-sends the kept Blob as a new job; 'poll' resumes waiting on
// the same job (it is still running on the PC — re-uploading would pay twice);
// null when a retry could only fail the same way. The pending id is kept for
// 'poll' so a reload resumes too.
function dictationFailed(message, retry) {
  clearTimeout(dict.pollTimer);
  dict.pollTimer = null;
  if (retry !== 'poll') dict.jobId = null;
  const kind = retry === 'upload' && dict.blob ? 'upload' : retry === 'poll' && dict.jobId ? 'poll' : null;
  if (kind) { keepForRetry(message, kind); return; }
  dict.blob = null; // nothing can use it any more
  dict.retryKind = null;
  setPhase('idle');
  dict.failToast = toast(esc(message), 'err');
}

// The failure stays in the dictation bar with Retry and Discard until one is
// tapped, a new recording starts or a launch succeeds. Launch and the mic stay
// usable meanwhile: a kept dictation blocks nothing.
function keepForRetry(message, kind) {
  dict.retryKind = kind;
  setPhase('failed', message);
}

function retryDictation() {
  if (dict.phase !== 'failed' || state.launching) return;
  const kind = dict.retryKind;
  dict.retryKind = null;
  if (kind === 'poll' && dict.jobId) {
    // Cancel dropped the pending id; waiting again must survive a reload again.
    savePending();
    startPolling();
  } else if (kind === 'upload' && dict.blob) uploadDictation();
  else discardDictation();
}

// Drops a dictation kept for Retry, and its pending id, so nothing from it can
// come back later: not in this page, not after a reload.
function discardDictation() {
  dict.blob = null;
  dict.jobId = null;
  dict.retryKind = null;
  store.remove(PENDING_KEY);
  if (dict.phase === 'failed') setPhase('idle');
}

// After a reload the Blob is gone but the job may not be: pick its result up
// and append it (the caret it was meant for belonged to the previous page).
function resumePendingDictation() {
  const raw = store.get(PENDING_KEY);
  if (!raw) return;
  let pending = null;
  try { pending = JSON.parse(raw); } catch { /* corrupt -> dropped below */ }
  const age = pending ? Date.now() - Number(pending.startedAt) : NaN;
  if (!dict.enabled || !pending || typeof pending.id !== 'string' || !(age >= 0)) {
    store.remove(PENDING_KEY);
    return;
  }
  if (age >= RESUME_MAX_AGE_MS) {
    store.remove(PENDING_KEY);
    // Said out loud: otherwise the draft comes back without the paragraph, as if
    // the dictation had never happened.
    toast(`A dictation from ${Math.round(age / 60000)} min ago had expired on the PC and could not be recovered.`, 'err');
    return;
  }
  dict.jobId = pending.id;
  dict.jobStartedAt = Number(pending.startedAt);
  dict.appendOnly = true;
  dict.resumedFrom = Number(pending.startedAt);
  startPolling();
}

function initDictation(cfg) {
  const t = cfg && cfg.transcribe;
  dict.enabled = !!(t && t.enabled);
  if (t && Number(t.maxSeconds) > 0) dict.maxSeconds = Number(t.maxSeconds);
  if (t && !t.enabled && t.reason) console.info('Dictation unavailable:', t.reason);
  $('micBtn').hidden = !dict.enabled;
  $('promptBox').classList.toggle('has-mic', dict.enabled);
  resumePendingDictation();
}

// ---------- init ----------
async function init() {
  // Before the network: a saved draft shows even if the PC is unreachable.
  restoreDraft();
  const ta = $('prompt');
  for (const ev of ['input', 'select', 'keyup', 'click', 'focus', 'blur']) ta.addEventListener(ev, rememberCaret);
  // iOS moves the caret with the loupe/drag handles without a click or keyup.
  document.addEventListener('selectionchange', () => { if (document.activeElement === ta) rememberCaret(); });
  ta.addEventListener('input', saveDraftSoon);
  // Only when the page has the dictation controls: an old cached index.html served
  // next to this script must still give a working launcher, just without the mic.
  const hasDictation = !!$('micBtn');
  if (hasDictation) {
    $('micBtn').addEventListener('click', () => {
      // not awaited: getUserMedia must stay in this tap
      if (dict.phase === 'idle' || dict.phase === 'failed') startDictation();
      else if (dict.phase === 'recording') finishRecording();
    });
    $('dictateCancel').addEventListener('click', cancelDictation);
    const retry = $('dictateRetry'); // missing from the first dictation release's HTML
    if (retry) retry.addEventListener('click', retryDictation);
  }
  $('toast').addEventListener('click', () => $('toast').classList.add('hidden'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { saveDraftNow(); return; }
    if (dict.phase === 'recording') acquireWakeLock(); // hiding the page released it
    // Timers are throttled or frozen in the background; check a pending job now.
    if (dict.phase === 'transcribing' && dict.jobId) {
      // The deadline is wall-clock and ran on while the page was frozen: give
      // the job a fair minute from now to be seen finishing.
      dict.pollDeadline = Math.max(dict.pollDeadline, Date.now() + 60 * 1000);
      schedulePoll(0);
    }
  });
  window.addEventListener('pagehide', () => {
    saveDraftNow();
    // Best effort: release the mic if the app is torn down mid-recording.
    if (dict.stream) dict.stream.getTracks().forEach((t) => t.stop());
  });

  try {
    const cfg = await api('/api/config');
    state.modes = cfg.modes;
    state.models = cfg.models || [];
    state.favorites = cfg.favorites;
    renderFavorites();
    renderModels();
    renderModes();
    setDir(state.favorites[0] ? state.favorites[0].path : '~');
    if (hasDictation) initDictation(cfg);
  } catch (e) {
    toast('Cannot reach launcher: ' + esc(e.message), 'err');
  }
  refreshSessions();

  $('dirSearch').addEventListener('input', onSearch);
  $('browseBtn').addEventListener('click', () => openBrowse(state.dir));
  $('browseUp').addEventListener('click', (e) => openBrowse(e.target.dataset.path || '~'));
  $('browseClose').addEventListener('click', () => $('browseModal').classList.add('hidden'));
  $('browseUse').addEventListener('click', () => {
    setDir(state.browseLabel || state.browseDir);
    $('browseModal').classList.add('hidden');
  });
  $('sessionsBtn').addEventListener('click', openSessions);
  $('sessionsClose').addEventListener('click', () => $('sessionsModal').classList.add('hidden'));
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  });
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
