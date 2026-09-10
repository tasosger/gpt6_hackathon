import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CaptureAssetSchema } from "../../lib/contracts";
import { uploadConfiguration } from "../../lib/server/uploads";

const mocks = vi.hoisted(() => ({ createSignedUploadUrl: vi.fn(), from: vi.fn() }));
vi.mock("../../lib/supabase/server", () => ({ supabaseAdmin: () => ({ storage: { from: mocks.from } }) }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockReturnValue({ createSignedUploadUrl: mocks.createSignedUploadUrl });
  mocks.createSignedUploadUrl.mockResolvedValue({ data: { token: "short-lived-upload-signature" }, error: null });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-project-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-only-secret");
});
afterEach(() => vi.unstubAllEnvs());
const asset = CaptureAssetSchema.parse({ id: "10000000-0000-4000-8000-000000000001", path: "owner/tutorial/video.mp4", name: "video.mp4", mimeType: "video/mp4", size: 1024, kind: "video", pass: "room" });

it("sends upload signatures to the signed TUS route, never the user-JWT route", async () => {
  const config = await uploadConfiguration(asset.id, asset);
  expect(config.endpoint).toBe("https://project.storage.supabase.co/storage/v1/upload/resumable/sign");
  expect(config.headers).toEqual({ apikey: "public-project-key", "x-signature": "short-lived-upload-signature" });
  expect(mocks.from).toHaveBeenCalledWith("captures");
  expect(mocks.createSignedUploadUrl).toHaveBeenCalledWith(asset.path, { upsert: false });
  expect(config.metadata).toMatchObject({ bucketName: "captures", objectName: asset.path, contentType: "video/mp4" });
  expect(JSON.stringify(config)).not.toContain("server-only-secret");
});

it("preserves local or custom storage hosts when renewing upload credentials", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  expect((await uploadConfiguration(asset.id, asset)).endpoint).toBe("http://127.0.0.1:54321/storage/v1/upload/resumable/sign");
});
