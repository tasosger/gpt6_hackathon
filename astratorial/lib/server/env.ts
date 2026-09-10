import { fail } from "./errors";
export function services() {
  // The tutorial worker ships with the app. This reports configuration, not process health.
  return { database: !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY), openai: !!process.env.OPENAI_API_KEY, worker: true };
}
export function requireDatabase() { if (!services().database) fail(503, "Connect Supabase and apply the database migration to enable uploads and saved tutorials.", "setup_required"); }
export function requireAI() { if (!services().openai) fail(503, "Add a server-side OpenAI API key to enable AI analysis and tutoring.", "setup_required"); }
export function requireVoice() { requireAI(); if (!process.env.LOCAL_VOICE_URL || !process.env.LOCAL_WORKER_TOKEN) fail(503, "Configure and start the local voice supervisor to enable live conversations.", "setup_required"); }
