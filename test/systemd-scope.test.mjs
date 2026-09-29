// Restarting the service must not take tmux down with it.
//
// The first `tmux new-session` after boot forks the tmux server, and without the
// transient scope in server.mjs that server is born inside claude-launcher.service's
// cgroup — where `systemctl --user restart claude-launcher` (KillMode=control-group)
// kills it, and every session on it.
//
// This runs server.mjs the way install.sh does, as a systemd user service, but as a
// throwaway transient unit with its own tmux socket dir (TMUX_TMPDIR) and a fake
// `claude` on PATH. It never touches the user's tmux server or the live service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, freePort, waitFor, baseConfig, missingTools } from './harness.mjs';

const execFileP = promisify(execFile);

async function userSystemd() {
  if (process.platform !== 'linux') return 'not Linux';
  const missing = await missingTools(['systemd-run', 'systemctl', 'tmux']);
  if (missing.length) return `missing: ${missing.join(', ')}`;
  try {
    await execFileP('systemctl', ['--user', 'is-system-running']);
  } catch (e) {
    // "degraded" exits non-zero but is a working manager.
    if (!/running|degraded/.test(String(e.stdout))) return 'no systemd user manager';
  }
  return false; // not null: node:test treats { skip: null } as skipped
}
const skip = await userSystemd();

test('a tmux server the service starts survives `systemctl --user stop`', { skip }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-launcher-scope-test-'));
  const unit = `claude-launcher-scope-test-${process.pid}`;
  // The test itself may run inside the user's tmux: $TMUX would point every tmux
  // call below at the real server, so it is dropped and the socket dir replaced.
  const { TMUX: _real, ...env } = process.env;
  const tmuxEnv = { ...env, TMUX_TMPDIR: path.join(dir, 'tmux') };
  const tmux = (...args) => execFileP('tmux', args, { env: tmuxEnv, timeout: 4000 });

  t.after(async () => {
    await tmux('kill-server').catch(() => {});
    await execFileP('systemctl', ['--user', 'stop', unit]).catch(() => {});
    await execFileP('systemctl', ['--user', 'reset-failed', unit]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  await mkdir(tmuxEnv.TMUX_TMPDIR, { mode: 0o700 });
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'claude'), '#!/bin/sh\nexec sleep 600\n');
  await chmod(path.join(bin, 'claude'), 0o755);
  const work = path.join(dir, 'work');
  await mkdir(work);
  const config = { ...baseConfig({ keyFile: path.join(dir, 'no-key') }), allowedRoots: [dir], remoteControl: false };
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config));

  const port = await freePort();
  await execFileP('systemd-run', [
    '--user', '--unit', unit, '--collect', '--quiet',
    '-p', 'KillMode=control-group', // the default, spelled out: it is what the test is about
    '-E', `PORT=${port}`,
    '-E', `CLAUDE_LAUNCHER_CONFIG=${configPath}`,
    '-E', `TMUX_TMPDIR=${tmuxEnv.TMUX_TMPDIR}`,
    '-E', `PATH=${bin}:/usr/local/bin:/usr/bin:/bin`,
    '-E', 'SHELL=/bin/sh',
    process.execPath, path.join(ROOT, 'server.mjs'),
  ]);
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitFor(() => fetch(base + '/api/health').then((r) => r.ok, () => false), { timeout: 10000 }),
    'server did not come up');

  const r = await fetch(base + '/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: work, name: 'scope-test', mode: 'normal' }),
  });
  const launched = await r.json();
  assert.equal(r.status, 200, JSON.stringify(launched));

  const pid = Number((await tmux('display-message', '-p', '#{pid}')).stdout.trim());
  assert.ok(pid > 0, 'no tmux server on the isolated socket');
  const cgroup = await readFile(`/proc/${pid}/cgroup`, 'utf8');
  assert.ok(!cgroup.includes(`/${unit}.service`), `tmux server is in the service's cgroup: ${cgroup.trim()}`);

  await execFileP('systemctl', ['--user', 'stop', unit]);
  assert.ok(await waitFor(async () => {
    try { await execFileP('systemctl', ['--user', 'is-active', unit]); return false; } catch { return true; }
  }, { timeout: 10000 }), 'service did not stop');
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.ok(alive, 'stopping the service killed the tmux server');
  await tmux('has-session', '-t', '=' + launched.session); // throws if the session died
});
