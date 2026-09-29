# Claude Launcher

A tiny installable iOS PWA that creates `tmux` + Claude Code sessions on this machine from your phone.

You pick a directory (favorites, frecency search, or browse), a model (**Opus** or **Fable**), optionally a name and an initial prompt, then tap **Claude** or **Ultracode**.

The session is created here; you attach to it from the **Claude app** (Remote Control is already on by default in your settings).

The initial prompt can also be dictated: tap the mic, speak, and the text is transcribed on this machine and dropped into the prompt for you to edit or launch.

## How it works

```
iPhone (Safari PWA)
   │  HTTPS  (tailscale serve, valid cert)
   ▼
https://<machine>.<tailnet>.ts.net/    ──► 127.0.0.1:8838  (node server.mjs)
                                              │
                                              ├─ GET  /api/config    favorites + modes + dictation status
                                              ├─ GET  /api/dirs?q=    zoxide (frecency) + fd (filesystem)
                                              ├─ GET  /api/browse     drill-down folder picker
                                              ├─ GET  /api/sessions   running tmux sessions
                                              ├─ POST /api/launch     tmux new-session + claude
                                              ├─ POST /api/transcribe       dictated audio -> 202 { id }
                                              └─ GET  /api/transcribe/<id>  processing | done + text | error
                                                        │
                                                        ▼
                                              ffmpeg -> AssemblyAI (batch API)
```

`POST /api/launch` runs, for the chosen directory:

```
tmux new-session -d -s <name> -c <dir> 'claude [mode args] --model <model> --remote-control <name> ["$(cat <promptfile>)"]; exec $SHELL -i'
```

`claude` is the pane's own command rather than keystrokes typed into a shell, so it can't race a shell still sourcing its rc; `exec $SHELL -i` leaves a normal shell in the pane when `claude` exits.

Under systemd the `tmux` call is wrapped in `systemd-run --user --scope` (see [Manage](#manage)).

- **Model** selector adds `--model <opus|fable>` (defaults to the first entry in `models`).
- **Ultracode** button adds `--settings {"ultracode":true}` (xhigh + dynamic workflow orchestration).
- `--remote-control <name>` names the session so it shows up in the Claude app.
- The initial prompt is written to a temp file and read with `$(cat …)`, so the typed command stays one line and is safe with any quotes/newlines.

## Directory navigation

- **Favorites** — chips, edit them in `config.json`.
- **Search** — type any fragment; results come from `zoxide` (ranked by how often you actually `cd` there) merged with a live `fd` filesystem search, so even an obscure subdir you rarely touch is one fuzzy query away.
- **Browse** — tap to drill down folder by folder when you don't remember the name.

All directory access is restricted to `allowedRoots` in `config.json` (default `~`).

## Dictation

Tap the mic in the prompt box, speak, tap it again.

The words land in the prompt at the cursor (at the end if you never placed one), with a space added where they meet other words; edit them or launch straight away.

English, Portuguese and German are detected per clip, so you can switch between them freely.

The mic only works through the `https://…ts.net` URL: browsers expose the microphone to secure pages only.

### How a clip travels

1. The phone records with `MediaRecorder` (AAC in fragmented MP4 on iOS, Opus in MP4 on current desktop Chrome, Opus in WebM on Firefox and older Chrome) and, on stop, POSTs the raw bytes to `/api/transcribe`, which answers `202 { id }` once the whole clip has arrived.

2. The server streams the body into a private temp dir (`0700`, files `0600`) and runs one `ffmpeg` pass to mono 16 kHz mp3.

    `ffmpeg` only accepts the containers browsers record (MP4, WebM/Matroska, Ogg, WAV, AAC, MP3); anything else, a playlist included, is "no audio captured".

3. `ffprobe` measures the result, and that duration is the only success check.

    A clip that is nothing but a container header converts "successfully" into an empty mp3, so exit codes and file sizes prove nothing (lesson from `../audiorecorder`).

    Under 0.5 s is "no audio captured"; more than 5 s over `maxSeconds` is refused.

4. The mp3 is read into memory and the temp dir is deleted before any network traffic.

5. The clip goes to AssemblyAI's batch API: upload, submit with language detection (`en`/`pt`/`de`, English fallback) and your key terms, then a status check every second for up to 4 minutes.

    Status checks that fail transiently (network, timeout, 5xx, 429) are waited out for up to a minute since the last good answer.

6. The phone polls `GET /api/transcribe/<id>` until it reads `done` (with `text`, `language`, `durationMs`) or `error`.

    `done` with an empty `text` means no speech was detected.

    `error` always carries `retryable`.

    It is `false` when sending the same clip again would fail the same way, and then a `code` says why: `no_audio` (too short or not audio), `too_long` (over `maxSeconds`) or `conversion` (ffmpeg choked on the clip).

7. The server deletes the transcript at AssemblyAI, which deletes the uploaded audio there too.

The prompt draft is autosaved in the phone's localStorage, and so is the id of a pending transcription, so a reload or a killed app during transcription doesn't lose the text: reopen it within 30 minutes and the transcript still arrives, appended at the end with a note saying so.

Reopened later than that, the app says the dictation expired instead of leaving it out silently.

A recording still in progress lives only in the phone's memory, though, and dies with the app.

The launch buttons are disabled while recording or transcribing.

**Cancel** works in both: while recording it throws the clip away; while transcribing it stops waiting, frees the launch buttons at once, and keeps the dictation for Retry.

### When a dictation fails

A failed dictation stays in the bar under the prompt with **Retry** and **Discard**, and the launch buttons and the mic stay usable meanwhile.

Retry sends the same recording again, or, when the PC was only unreachable, keeps waiting on the job already running there instead of paying for a second transcription.

A new recording or a successful launch discards it, pending id included, so its text can't turn up in a later prompt.

Retry isn't offered when the same clip would fail the same way: too short, over the length limit, too large to send, or dictation turned off on the PC (no key, no `ffmpeg`).

Those show a message and nothing more.

### Requirements

- `ffmpeg` and `ffprobe` on the service's `PATH`, with the `libmp3lame` encoder (Arch's `ffmpeg` package has it).
- An AssemblyAI API key.

The mic button is hidden while either is missing.

`GET /api/config` says why in `transcribe.reason`.

### Key and key terms

The key is read for every dictation from the `ASSEMBLYAI_API_KEY` environment variable, or else from `assemblyai_api_key` in `~/.config/audiorecorder/config` — the file `../audiorecorder` already uses, so the key is set once for both.

The format is the same as there: `key=value` lines, `#` comments, and the last uncommented value wins.

`assemblyai_keyterms` (comma-separated) in the same file is sent as AssemblyAI key terms, which bias recognition towards those words.

Phrases longer than six words are dropped and the list is capped at 1000, AssemblyAI's limits.

If AssemblyAI ever rejects the key terms, the dictation is retried without them rather than failed.

The key never leaves this machine and is never logged; the phone holds no secret.

### Settings

```json
"transcription": { "enabled": true, "keyFile": "~/.config/audiorecorder/config", "maxSeconds": 600, "maxBytes": 26214400 }
```

- `enabled` — `false` hides the mic.
- `keyFile` — where the key and key terms are read from.
- `maxSeconds` — the longest dictation; the phone stops recording there.
- `maxBytes` — upload size cap, 25 MB (a ten-minute clip is about 5 MB).

Every key is optional and defaults to the value shown.

Like the rest of `config.json`, the block is re-read on each request.

At most 4 transcriptions run at once; a fifth upload gets `429`.

### Retention

Nothing is kept on this PC.

The audio lives in the temp dir only until it has been converted, and the dir is removed on every path, success or failure.

Stopping the service (`SIGTERM`, or `^C` by hand) removes the temp dirs of uploads still in progress before it exits.

Temp dirs orphaned by a crash are swept at the next start and every 10 minutes after.

The transcript is held in memory only, until 30 minutes after its job finished (a restart drops it sooner).

The logs record job ids, sizes, durations, timings, language and status — never the transcript text.

At AssemblyAI, the transcript (and with it the uploaded audio) is deleted as soon as the text is back; a delete that fails transiently (network, timeout, 5xx, 429) is tried again up to three times over about a minute and a half.

If the server stopped waiting early, it keeps checking in the background for up to 30 minutes and deletes the transcript once it finishes; AssemblyAI refuses to delete one that is still processing.

That clean-up is best effort: if the server restarts in between, or every delete attempt fails, AssemblyAI keeps the transcript for 30 days, and an upload whose submit failed can't be deleted through the API at all (it expires there within 24–48 h).

On the phone, the prompt draft stays in localStorage until you launch or clear it.

The id of a pending transcription goes when its text lands, when you launch, record again, Discard, or Cancel while it transcribes.

## Install

```bash
cd ~/development/claude-launcher
./install.sh
```

This writes a systemd **user** service (auto-starts on boot, restarts on failure), starts it, and runs `tailscale serve` to expose it over HTTPS.

On the first run it creates `config.json` from `config.example.json` and adds the machine's tailnet name to `allowedHosts`.

Then on your iPhone: open the printed `https://…ts.net/` URL in Safari → **Share → Add to Home Screen**.

Dictation also needs `ffmpeg` on this machine and an AssemblyAI key; see [Requirements](#requirements).

> HTTPS needs Tailscale HTTPS certificates enabled for your tailnet (one toggle
> in the admin console). The installer tells you if it isn't.

## Configure

Everything lives in `config.json` (re-read on each request — no restart needed for favorites/modes).

It is your local copy and is not tracked by git; `config.example.json` is the template `install.sh` starts from.

Keys:

- `favorites` — pinned directory chips (`~` is expanded).
- `models` — the model choices (`id` = `--model` value + `label`; first is the default).

  Each has an optional `arg` if the CLI value differs from the `id`.
- `modes` — the launch buttons and their `claude` args.
- `allowedRoots` — directories the launcher may touch.
- `token` — optional shared secret (`x-launcher-token` header / `?token=`).

  Off by default; the tailnet is the auth boundary.
- `remoteControl` — append `--remote-control <name>` (default `true`).
- `transcription` — dictation, see [Dictation](#dictation).

## Manage

```bash
systemctl --user status claude-launcher
systemctl --user restart claude-launcher
journalctl --user -u claude-launcher -f
tailscale serve status
```

A restart never touches your tmux sessions.

The launcher runs `tmux new-session` inside a transient systemd scope (`systemd-run --user --scope`), so a tmux server it happens to start gets a cgroup of its own.

Without that, the first session after boot would fork the tmux server inside `claude-launcher.service`'s cgroup, and a restart (`KillMode=control-group`) would kill it together with every session on it.

A tmux server started before this change may still sit in the service's cgroup.

Check with `systemctl --user status claude-launcher`: the `CGroup:` tree must list only `node … server.mjs`.

## Security model

- The server binds `127.0.0.1`.

  That is reachable by **any process or browser tab on this machine** (not only the tailnet) and is fronted by `tailscale serve` for remote access.

  So two boundaries matter:
  - **Tailnet** — anyone on your tailnet who opens the URL can launch sessions.
  - **Local browser** — a malicious page you open could otherwise POST to `127.0.0.1:8838`.

    The server blocks this with a `Sec-Fetch-Site` cross-site guard, a JSON-only content-type requirement on `/api/launch`, and a `Host` allowlist (`allowedHosts`, also stops DNS-rebinding).

    For stronger isolation set `token` in `config.json` and send it as `x-launcher-token`.
- `POST /api/transcribe` accepts only `Content-Type: audio/*`.

  That is not a CORS-safelisted type, so a cross-origin page can't send the request without a preflight, and the preflight is never answered — the same reasoning as the JSON requirement on `/api/launch`.

  A plain HTML form can't produce it at all.
- Uploads are capped at `maxBytes`.

  An oversized `Content-Length` is refused before a byte is read, and a body that grows past the cap mid-stream is cut off.

  Every refusal of an unread body also closes the connection, so leftover audio can never be parsed as the next request on a keep-alive socket.
- The dictation endpoints sit behind the same `Sec-Fetch-Site` guard, `Host` allowlist and optional `token` as the rest of `/api/*`.

  Job ids are random UUIDs, and job results are sent with `Cache-Control: no-store`.
- `ffmpeg` and `ffprobe` run without a shell (argument arrays) and with timeouts; the uploaded bytes are only ever data to them.

  `ffmpeg` is limited to the containers browsers record (`-format_whitelist`).

  Left to probe, it also accepts playlists: an uploaded DASH manifest would make it open and decode any local audio or video file it names, and the transcript would come back to the phone.
- Directory access is confined to `allowedRoots` (default `~`) on the **real** path, so symlinks can't escape.
- The launcher talks to your normal tmux server (`/tmp/tmux-$(id -u)/default`), so sessions appear in your interactive `tmux ls` too.
- Zero npm dependencies — pure Node standard library.

  Dictation runs `ffmpeg`/`ffprobe` as child processes and calls AssemblyAI with the built-in `fetch`.

## Tests

```bash
node --test test/transcribe.test.mjs   # the dictation API (about 25 s)
node test/browser.mjs                  # the PWA in headless Chromium with a fake microphone (about 45 s)
node --test test/systemd-scope.test.mjs  # a service stop leaves the tmux server alive (under 1 s)
```

`systemd-scope.test.mjs` runs `server.mjs` as a throwaway transient user service with its own tmux socket dir (`TMUX_TMPDIR`) and a fake `claude` on `PATH`, launches one session, stops the service and checks the tmux server survived.

It never talks to your tmux server, and it skips itself without a systemd user manager or `tmux`.

Name the file: on Node 26 `node --test test/` fails with "Cannot find module", because a directory argument is loaded as a module.

A bare `node --test` from the project root also works; it picks up every `.mjs` under `test/` and runs `browser.mjs` as one more test.

Both need `espeak-ng` and `ffmpeg`/`ffprobe` (with the `aac`, `libopus` and `libmp3lame` encoders), because the audio is generated at test time.

Without them the audio cases are skipped, and `browser.mjs` prints `SKIPPED` and exits 0.

`browser.mjs` also needs Playwright's Chromium: a local `playwright` install if there is one, otherwise the global one (`npm install -g playwright && npx playwright install chromium`).

It prints one `ok`/`FAIL` line per check, then `PASS` or `FAIL` with the counts, and exits non-zero on any failure.

### What they touch

Nothing of the live setup.

Each test starts its own `server.mjs` on a free port, with a throwaway `config.json`, a fake key file, its own `TMPDIR` and a stub AssemblyAI (a small `node:http` server inside the test process).

The launch buttons are never pressed.

The browser test also aborts `/api/launch` at the network layer, and the test config's `allowedRoots` is a scratch dir, so even a stray launch would be refused.

`test/harness.mjs` holds that shared plumbing: the stub, the server spawner and the clip generator.

### What they cover

`transcribe.test.mjs` sends an iOS-shaped fragmented MP4/AAC clip and a WebM/Opus clip (Firefox, older Chrome) through the real server and `ffmpeg`; current Chrome's Opus in MP4 is covered by `browser.mjs`.

It checks the mp3 the stub received (mono 16 kHz, full length) and the request it got: auth header, language detection, cleaned-up key terms.

It checks where the key comes from: the environment over the file, the last uncommented line winning, and dictation disabled with a reason when there is no key, all re-read without a restart.

It checks failures at AssemblyAI (a transcript error, a 401 or 500 on upload, key terms rejected and retried without them, five status checks in a row reset, a delete reset once) and bad audio (0.2 s, not audio at all, over `maxSeconds`), including which of them are marked not retryable.

It checks that an uploaded DASH manifest can't make `ffmpeg` read a local file, that `ffmpeg` killed for flooding its log is a failed conversion rather than a truncated transcript, and that a stop mid-upload leaves no clip behind.

It checks that a broken `transcription` block only turns dictation off, with `/api/config` still answering.

It checks every refusal: 415, 413 by header and by stream (with the socket closed rather than drained), 400, 403 cross-site, 404, and 429 past four concurrent jobs.

After every case it checks that no dictation temp dir is left, and at the end that neither the key nor any transcript text reached the server log.

`browser.mjs` dictates into the middle of a typed prompt and checks the text lands at the caret with one space each side.

It checks the recording UI (timer, level meter, launch buttons disabled), the draft surviving a reload, and Cancel uploading nothing.

It checks a failure kept in the bar (launch buttons usable and uncovered at 390×844 and 375×667, surviving other toasts), Retry re-sending the same recording, a new recording or Discard replacing it, and Retry left out for a too-short clip, 503, 413 and 415 but kept for 429, 502 and network errors.

It checks a reload mid-transcription resuming the job 15 minutes on, one past 30 minutes reported as expired, Cancel freeing the page from a hung poll with Retry then waiting on the same job, a failed first poll after a long suspend not ending the dictation, a new recording dropping an old pending id, an old cached `index.html` still giving working launch buttons, and no console errors.

Neither covers a real iPhone: Chromium never records AAC, so iOS recorder behaviour (chunk timing, a `stop` event that never fires) still needs a check on the phone.

### Test hooks in the server

Three environment variables let a test run its own server without touching the live service, its config or the AssemblyAI account:

- `CLAUDE_LAUNCHER_CONFIG` — the `config.json` to use instead of the one next to `server.mjs`.
- `ASSEMBLYAI_BASE_URL` — the AssemblyAI API root (default `https://api.assemblyai.com`), for pointing at a stub.
- `ASSEMBLYAI_API_KEY` — the key, overriding the key file.

## Teardown

```bash
systemctl --user disable --now claude-launcher
tailscale serve reset   # stop exposing it over HTTPS
```

## License

[MIT](LICENSE)
