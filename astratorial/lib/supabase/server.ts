import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { requireDatabase } from "@/lib/server/env";
import { fail } from "@/lib/server/errors";

export async function supabaseServer() {
  requireDatabase();
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => store.getAll(), setAll(values) { for (const { name, value, options } of values) store.set(name, value, options); } },
  });
}
export function supabaseAdmin() {
  requireDatabase();
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
}
export async function currentUser() { const client = await supabaseServer(); const { data: { user }, error } = await client.auth.getUser(); if (error || !user) return null; return { id: user.id }; }
export async function requireUser() { const user = await currentUser(); if (!user) fail(401, "Your guest session is unavailable. Refresh and try again.", "guest_session_required"); return user; }
