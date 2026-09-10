import { afterEach, describe, expect, it, vi } from "vitest";
import { api, errorMessage } from "../../lib/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function waitUntilAborted(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
    else signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

describe("actionable client request failures", () => {
  it("keeps an actionable server explanation when a private workspace cannot be created", async () => {
    const message = "Anonymous sign-ins are disabled. Enable Allow anonymous sign-ins, then try again.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "guest_session_disabled", message } }, { status: 503 })));
    await expect(api("/api/auth/guest")).rejects.toMatchObject({ name: "ApiError", status: 503, message });
  });

  it("explains a lost connection instead of showing the browser's raw fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api("/api/config")).rejects.toMatchObject({ status: 0, message: expect.stringContaining("Check your internet connection and that the app is running") });
  });

  it("rejects a successful HTTP response that is not readable JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>A proxy response</html>", { status: 200, headers: { "Content-Type": "text/html" } })));
    await expect(api("/api/config")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("unreadable response") });
  });

  it("ends an unanswered request with a retryable explanation rather than an endless spinner", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return waitUntilAborted(requestSignal);
    }));
    const assertion = expect(api("/api/uploads")).rejects.toMatchObject({ status: 408, message: expect.stringContaining("Your request may still be processing") });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("also limits a response whose headers arrive but whose body never finishes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => ({ ok: true, status: 200, json: () => waitUntilAborted(init.signal as AbortSignal) })));
    const assertion = expect(api("/api/config")).rejects.toMatchObject({ status: 408, details: { code: "request_timeout" } });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("distinguishes an intentionally cancelled request from an unavailable connection", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) => waitUntilAborted(init.signal as AbortSignal)));
    const assertion = expect(api("/api/config", { signal: controller.signal })).rejects.toMatchObject({ status: 499, message: "The request was stopped." });
    controller.abort();
    await assertion;
  });

  it("does not expose a signed service URL or private key in upload error messages", () => {
    const message = errorMessage(new Error("Upload failed at https://storage.example/upload?token=private with sk-test-placeholder_only"));
    expect(message).toContain("Upload failed");
    expect(message).not.toContain("token=private");
    expect(message).not.toContain("sk-test");
  });
});
