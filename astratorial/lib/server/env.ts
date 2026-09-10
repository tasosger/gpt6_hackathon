import { fail } from "./errors";
export function localMode() { return process.env.ASTRATORIAL_LOCAL_WORKER === "1"; }
export function services() {
  return { database: !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY), openai: !!process.env.OPENAI_API_KEY, worker: localMode() || !!(process.env.MODAL_WORKER_URL && process.env.MODAL_WORKER_TOKEN) };
}
export function requireDatabase() { if (!services().database) fail(503, "Connect Supabase and apply the database migration to enable accounts, uploads, and saved tutorials.", "setup_required"); }
export function requireAI() { if (!services().openai) fail(503, "Add a server-side OpenAI API key to enable AI analysis and tutoring.", "setup_required"); }
export function requireWorker() { if (!services().worker) fail(503, "Start the local tutorial worker or configure the cloud worker to generate tutorials.", "setup_required"); }
export function requireVoice() { requireAI(); requireWorker(); if (!(process.env.LOCAL_VOICE_URL || process.env.MODAL_VOICE_URL)) fail(503, "Start the voice supervisor to enable live conversations.", "setup_required"); }
