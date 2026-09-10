import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const required = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'LOCAL_WORKER_TOKEN'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  console.error(`Add these settings to .env.local first: ${missing.join(', ')}`);
  process.exit(1);
}
let demo;
let closing = false;
let output = '';
const port = process.env.PORT || '4173';
const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
const timeout = setTimeout(() => { console.error('The phone link could not be created. Check your connection and try again.'); stop(1); }, 60_000);
function stop(code = 0) {
  if (closing) return;
  closing = true;
  clearTimeout(timeout);
  for (const child of [demo, tunnel]) {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
  }
  process.exitCode = code;
}
function onOutput(chunk) {
  output = (output + chunk.toString()).slice(-65_536);
  const address = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (address && !demo && !closing) {
    clearTimeout(timeout);
    console.log(`\nOpen this link on your phone: ${address}\nStarting Astratorial. Keep this terminal open; Ctrl+C stops the demo and its phone link.\n`);
    demo = spawn(process.execPath, ['scripts/demo.mjs', ...process.argv.slice(2)], {
      cwd: root,
      env: { ...process.env, ASTRATORIAL_PUBLIC_URL: address },
      stdio: 'inherit',
      detached: true,
    });
    demo.on('error', () => { console.error('Astratorial could not start.'); stop(1); });
    demo.on('exit', code => stop(code || 0));
  }
}
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
tunnel.on('error', () => { console.error('Install the phone link helper first: brew install cloudflared'); stop(1); });
tunnel.on('exit', code => { if (!closing) { console.error('The phone link closed.'); stop(code || 1); } });
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
