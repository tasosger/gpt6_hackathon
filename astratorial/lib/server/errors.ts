import { ZodError } from "zod";

export class AppError extends Error {
  constructor(public status: number, message: string, public code = "request_failed") { super(message); }
}
export function fail(status: number, message: string, code?: string): never { throw new AppError(status, message, code); }
export function assertRequestOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === new URL(request.url).origin) return;
  // The bind address (0.0.0.0) differs from the browser's localhost address, and
  // a phone tunnel terminates on loopback. Only explicitly configured browser
  // origins are trusted; caller-supplied forwarding headers cannot grant access.
  for (const appUrl of [process.env.NEXT_PUBLIC_APP_URL, process.env.ASTRATORIAL_PUBLIC_URL]) {
    if (!appUrl) continue;
    try { const configured = new URL(appUrl); if (["http:", "https:"].includes(configured.protocol) && origin === configured.origin) return; } catch { /* Invalid configuration cannot grant access. */ }
  }
  fail(403, "This page is using an unrecognized address. Open Astratorial from its configured link and try again.", "unrecognized_origin");
}
export function api<T extends unknown[]>(handler: (...args: T) => Promise<Response>) {
  return async (...args: T) => {
    try { return await handler(...args); }
    catch (error) {
      if (error instanceof ZodError) return Response.json({ error: "Please check the submitted information.", code: "invalid_input", details: error.issues.map(i => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
      if (error instanceof AppError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
      // Never return provider bodies, credentials, media, or raw database errors.
      console.error("Astratorial request failed", error instanceof Error ? error.name : "UnknownError");
      return Response.json({ error: "Something went wrong. Please try again.", code: "internal_error" }, { status: 500 });
    }
  };
}
export async function body(request: Request, maxBytes = 128_000): Promise<unknown> {
  if (Number(request.headers.get("content-length") || 0) > maxBytes) fail(413, "This request is too large.");
  assertRequestOrigin(request);
  if (!request.headers.get("content-type")?.includes("application/json")) fail(415, "Send this request as JSON.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "A request body is required.");
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > maxBytes) { await reader.cancel(); fail(413, "This request is too large."); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(400, "The request contains invalid JSON."); }
}
export function dbError(error: { code?: string; message?: string } | null) {
  if (!error) return;
  const message = error.message || "";
  if (/stale|revision|active job|already|lease|conflict/i.test(message)) fail(409, "The tutorial changed or another operation is active. Refresh and try again.", "conflict");
  if (/upload limit/i.test(message)) fail(413, message.replace(/^.*upload limit: /, "Upload limit: ").replace(/\baccounts?\b/gi, word => word.toLowerCase() === "accounts" ? "guest libraries" : "guest library"), "upload_limit");
  if (/practice budget/i.test(message)) fail(402, "This practice session has reached its $2 visual-check allowance. You can continue with manual step confirmation.", "practice_budget_exhausted");
  if (/voice budget/i.test(message)) fail(402, "This conversation has reached its $2 voice allowance. You can continue watching or practicing without voice.", "voice_budget_exhausted");
  if (/budget/i.test(message)) fail(402, "This revision has reached its generation allowance.", "budget_exhausted");
  if (/not found/i.test(message)) fail(404, "This item is unavailable.");
  if (/rate|in flight/i.test(message)) fail(429, "Please wait a moment before trying again.");
  if (/permission|owner|unauthorized/i.test(message)) fail(403, "You do not have access to this item.");
  fail(503, "The database could not complete this request. Check that the Astratorial migration has been applied.", "database_unavailable");
}
export type IdContext = { params: Promise<{ id: string }> };
