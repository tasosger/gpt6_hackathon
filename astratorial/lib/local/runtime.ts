import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const runtimeDirectory = () => join(process.cwd(), ".astratorial");
const snapshotPath = () => join(runtimeDirectory(), "worker.json");
export type WorkerStatus = { status: "ready" | "offline" | "unreachable"; message: string };

export function workerStatusFromSnapshot(value: unknown, now: number, alive: (pid: number) => boolean): WorkerStatus {
  const snapshot = value as { pid?: number; updatedAt?: number; queueConnected?: boolean } | null;
  if (!snapshot || !Number.isInteger(snapshot.pid) || snapshot.pid! <= 0 || !Number.isFinite(snapshot.updatedAt)
    || now - snapshot.updatedAt! > 20_000 || snapshot.updatedAt! - now > 5_000 || !alive(snapshot.pid!)) {
    return { status: "offline", message: "The tutorial worker is offline. Start the local demo on the host computer to process videos." };
  }
  if (snapshot.queueConnected !== true) return { status: "unreachable", message: "The tutorial worker is running but can’t reach saved jobs. Check the host computer’s internet and storage connection." };
  return { status: "ready", message: "The tutorial worker is running." };
}

const remotePath = "_runtime/tutorial-worker.json";
function heartbeatStorage() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) } }).storage.from("tutorial-assets") : null;
}

export function remoteWorkerStatus(value: unknown, now = Date.now()): WorkerStatus {
  // A remote PID has no meaning on Vercel. Trust only a fresh, private heartbeat.
  return workerStatusFromSnapshot(value, now, () => true);
}

export async function readWorkerStatus(): Promise<WorkerStatus> {
  if (process.env.VERCEL) {
    try {
      const result = await heartbeatStorage()?.download(remotePath, {}, { cache: "no-store" });
      if (result?.data) return remoteWorkerStatus(JSON.parse(await result.data.text()));
    } catch { /* Missing or unreachable heartbeat is never reported as ready. */ }
    return remoteWorkerStatus(null);
  }
  let snapshot: unknown = null;
  try { snapshot = JSON.parse(await readFile(snapshotPath(), "utf8")); } catch { /* A worker that has not started has no heartbeat. */ }
  return workerStatusFromSnapshot(snapshot, Date.now(), pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
}

export async function writeWorkerHeartbeat(queueConnected: boolean) {
  await mkdir(runtimeDirectory(), { recursive: true, mode: 0o700 });
  const temporary = join(runtimeDirectory(), `worker-${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({ pid: process.pid, updatedAt: Date.now(), queueConnected }), { mode: 0o600 });
  await rename(temporary, snapshotPath());
  const storage = heartbeatStorage();
  if (storage) {
    const { error } = await storage.upload(remotePath, JSON.stringify({ pid: process.pid, updatedAt: Date.now(), queueConnected }), { upsert: true, contentType: "application/json", cacheControl: "0" });
    if (error) throw new Error("Remote worker heartbeat could not be saved.");
  }
}
