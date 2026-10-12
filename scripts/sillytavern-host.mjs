// Diagnostic against an explicit external checkout; never starts a user's existing profile.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';

export async function withSillyTavern(checkout, run) {
  checkout = resolve(checkout);
  const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('Probe requires a clean tracked SillyTavern checkout');
  const temp = await mkdtemp(join(tmpdir(), 'unity-sillytavern-'));
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((done) => socket.close(done));
  await writeFile(join(temp, 'config.yaml'), `listen: false\nprotocol:\n  ipv4: true\n  ipv6: false\nbrowserLaunch:\n  enabled: false\nextensions:\n  enabled: false\n  autoUpdate: false\n  models:\n    autoDownload: false\nenableDownloadableTokenizers: false\nenableServerPlugins: false\nenableServerPluginsAutoUpdate: false\n`);
  let log = '';
  const child = spawn(process.execPath, ['server.js', '--configPath', join(temp, 'config.yaml'), '--dataRoot', join(temp, 'data'), '--port', String(port), '--browserLaunchEnabled', 'false'], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { log += chunk; }); child.stderr.on('data', (chunk) => { log += chunk; });
  const stopped = once(child, 'exit');
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
  const cookies = new Map(); let token;
  async function request(path, init = {}) {
    const headers = new Headers(init.headers); headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (token) headers.set('x-csrf-token', token);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    return response;
  }
  try {
    const started = Date.now();
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`SillyTavern exited before readiness: ${child.exitCode}`);
      try { token = (await (await request('/csrf-token')).json()).token; break; }
      catch (error) { if (Date.now() - started > 60_000) throw error; await new Promise((done) => setTimeout(done, 200)); }
    }
    return await run({ request, commit });
  } finally {
    stop();
    const forceStop = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
    await stopped; clearTimeout(forceStop);
    for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, stop);
    await mkdir('runtime', { recursive: true }); await writeFile('runtime/sillytavern-probe.log', log);
    await rm(temp, { recursive: true, force: true });
  }

}
