import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ storage: { from: () => ({ download }) } }) }));
import { readWorkerStatus } from "../../lib/local/runtime";

describe("production worker heartbeat", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-server-key");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
  it("reads a fresh remote heartbeat without caching it or checking a local PID", async () => {
    download.mockResolvedValue({ data: new Blob([JSON.stringify({ pid: 999999, updatedAt: Date.now(), queueConnected: true })]) });
    expect((await readWorkerStatus()).status).toBe("ready");
    expect(download).toHaveBeenCalledWith("_runtime/tutorial-worker.json", {}, { cache: "no-store" });
  });
  it("never reports a failed remote heartbeat request as ready", async () => {
    download.mockRejectedValue(new Error("Request timed out"));
    expect((await readWorkerStatus()).status).toBe("offline");
  });
  it("rejects a stale snapshot even when storage successfully returns it", async () => {
    download.mockResolvedValue({ data: new Blob([JSON.stringify({ pid: 999999, updatedAt: Date.now() - 21000, queueConnected: true })]) });
    expect((await readWorkerStatus()).status).toBe("offline");
  });
});
