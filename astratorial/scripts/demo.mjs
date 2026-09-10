import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const required = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'LOCAL_WORKER_TOKEN'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  console.error(`Add these settings to .env.local first: ${missing.join(', ')}`);
  process.exit(1);
}
const python = resolve('worker/.venv/bin/python');
if (!existsSync(python)) {
  console.error('Install the local voice runtime first; see the README quick start.');
  process.exit(1);
}
const dev = process.argv.includes('--dev');
if (!dev && !existsSync('.next/BUILD_ID')) {
  console.error('Run npm run build first, or use npm run demo -- --dev.');
  process.exit(1);
}
const port = Number(process.env.PORT || 4173);
for (const candidate of [port, 8766]) {
  try {
    await new Promise((done, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(candidate, '127.0.0.1', () => probe.close(done));
    });
  } catch {
    console.error(`Port ${candidate} is already in use. Stop the previous Astratorial process before starting the demo.`);
    process.exit(1);
  }
}
const env = {
  ...process.env,
  ASTRATORIAL_LOCAL_WORKER: '1',
  LOCAL_VOICE_URL: 'http://127.0.0.1:8766/voice',
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${port}`,
};
const children = new Set();
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
  const timer = setTimeout(() => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    process.exit(code);
  }, 5000);
  timer.unref();
  process.exitCode = code;
}
function launch(label, command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', detached: true });
  children.add(child);
  child.on('error', () => { console.error(`${label} could not start.`); shutdown(1); });
  child.on('exit', code => {
    children.delete(child);
    if (!closing) { console.error(`${label} stopped (${code ?? 'signal'}). Stopping the other demo services.`); shutdown(code || 1); }
  });
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
console.log(`Astratorial: http://localhost:${port} — press Ctrl+C to stop all three services.`);
launch('Website', process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--port', String(port), '--hostname', '0.0.0.0']);
launch('Tutorial worker', 'npm', ['run', 'worker']);
launch('Voice supervisor', python, ['worker/local_voice.py']);
