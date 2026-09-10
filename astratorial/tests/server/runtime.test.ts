import { describe, expect, it, vi } from "vitest";
import { workerStatusFromSnapshot, remoteWorkerStatus } from "../../lib/local/runtime";

describe("local worker availability", () => {
  const now = 1_000_000;
  it("reports a live consumer rather than treating configured credentials as a running process", () => {
    expect(workerStatusFromSnapshot({pid:123,updatedAt:now,queueConnected:true}, now, () => true).status).toBe("ready");
    expect(workerStatusFromSnapshot(null, now, () => true).status).toBe("offline");
    expect(workerStatusFromSnapshot({pid:123,updatedAt:now,queueConnected:true}, now, () => false).status).toBe("offline");
  });
  it("rejects stale, malformed and future heartbeats without trusting their process id", () => {
    const alive = vi.fn(() => true);
    for (const snapshot of [{pid:123,updatedAt:now-21_000}, {pid:123,updatedAt:now+10_000}, {pid:"123",updatedAt:now}, {pid:-1,updatedAt:now}]) {
      expect(workerStatusFromSnapshot(snapshot,now,alive).status).toBe("offline");
    }
    expect(alive).not.toHaveBeenCalled();
  });
  it("distinguishes a running worker with a broken queue connection", () => {
    const status = workerStatusFromSnapshot({pid:123,updatedAt:now,queueConnected:false}, now, () => true);
    expect(status.status).toBe("unreachable");
    expect(status.message).toContain("can’t reach saved jobs");
    expect(status).not.toHaveProperty("pid");
  });
});

 it("checks remote freshness without looking for the worker PID on the web server", () => {
   const now = Date.now();
   expect(remoteWorkerStatus({pid:999999,updatedAt:now,queueConnected:true},now).status).toBe("ready");
   expect(remoteWorkerStatus({pid:999999,updatedAt:now-21000,queueConnected:true},now).status).toBe("offline");
   expect(remoteWorkerStatus({pid:999999,updatedAt:now,queueConnected:false},now).status).toBe("unreachable");
 });
