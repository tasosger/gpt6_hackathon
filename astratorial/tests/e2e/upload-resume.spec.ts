import { expect, test } from "@playwright/test";
import type { CaptureAsset, Tutorial } from "../../lib/contracts";
import { getExample } from "../../lib/examples";

test("resumes an interrupted capture after reload with the same ticket and a renewed token", async ({ page, baseURL }) => {
  const id = "33333333-3333-4333-8333-333333333333";
  const uploadId = "44444444-4444-4444-8444-444444444444";
  const size = 7_000_000;
  const savedOffset = 6_291_456;
  const endpoint = new URL("/fixture-tus", baseURL).href;
  const resource = `${endpoint}/resource`;
  const asset: CaptureAsset = { id: uploadId, path: `${id}/room.webm`, name: "room.webm", mimeType: "video/webm", size, kind: "video", pass: "room" };
  const tutorial: Tutorial = { ...getExample("example-espresso")!, id, ownerId: "fixture-owner", isExample: false, visibility: "private", status: "draft", plan: null, scene: null, job: null, assets: [], measurements: [] };
  let ticket: { uploadId: string; asset: CaptureAsset; revision: number; createdAt: string; clientFingerprint: string } | null = null;
  let creations = 0;
  let renewals = 0;
  let interrupted = false;
  let completed = false;
  let analysisStarted = false;
  let resumedOffset: string | undefined;
  let resumedToken: string | undefined;
  let resumedBytes = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const configuration = () => ({ uploadId, asset, endpoint, headers: { "x-signature": renewals ? "renewed-token" : "initial-token" }, metadata: { bucketName: "captures", objectName: asset.path, contentType: asset.mimeType }, chunkSize: savedOffset });
  const job = { id: "upload-resume-job", kind: "analyze", status: "queued", progress: 0, message: "Fixture analysis queued" };

  await page.route("**/api/config", route => route.fulfill({ json: { configured: true, services: { database: true, openai: true, worker: true }, user: { id: "fixture-owner", email: "test@example.com" } } }));
  await page.route(`**/api/tutorials/${id}`, route => route.fulfill({ json: { tutorial: completed ? { ...tutorial, assets: [asset] } : tutorial } }));
  await page.route("**/api/uploads?*", route => route.fulfill({ json: { uploads: ticket ? [ticket] : [] } }));
  await page.route("**/api/uploads", route => {
    const input = route.request().postDataJSON();
    creations++;
    // Store the browser's fingerprint; the test does not reproduce its algorithm.
    ticket = { uploadId, asset, revision: tutorial.revision, createdAt: new Date().toISOString(), clientFingerprint: input.clientFingerprint };
    return route.fulfill({ json: configuration() });
  });
  await page.route(`**/api/uploads/${uploadId}/renew`, route => { renewals++; return route.fulfill({ json: configuration() }); });
  await page.route("**/api/uploads/complete", route => { completed = true; return route.fulfill({ json: { tutorial: { ...tutorial, assets: [asset] }, asset } }); });
  await page.route(`**/api/tutorials/${id}/analyze`, route => { analysisStarted = true; return route.fulfill({ json: { job } }); });
  await page.route("**/api/jobs/upload-resume-job", route => route.fulfill({ json: { job } }));
  await page.route("**/fixture-tus", route => route.fulfill({ status: 201, headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(savedOffset), Location: resource } }));
  await page.route("**/fixture-tus/resource", route => {
    if (route.request().method() === "HEAD") return route.fulfill({ status: 200, headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(savedOffset), "Upload-Length": String(size) } });
    if (!renewals) { interrupted = true; return route.abort("internetdisconnected"); }
    resumedOffset = route.request().headers()["upload-offset"];
    resumedToken = route.request().headers()["x-signature"];
    resumedBytes = route.request().postDataBuffer()?.length ?? 0;
    return route.fulfill({ status: 204, headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(size) } });
  });

  const reselect = () => page.locator('input[type="file"]').evaluate((input, byteLength) => {
    const files = new DataTransfer();
    files.items.add(new File([new Uint8Array(byteLength)], "room.webm", { type: "video/webm", lastModified: 123456789 }));
    (input as HTMLInputElement).files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, size);
  await page.goto(`/create?id=${id}`);
  await expect(page.getByRole("button", { name: "Get to know my space", exact: true })).toBeVisible();
  await reselect();
  await page.getByRole("button", { name: "Get to know my space", exact: true }).click();
  await expect.poll(() => interrupted).toBe(true);
  await page.reload();
  await expect(page.getByText("Continue an interrupted upload.", { exact: true })).toBeVisible();
  await reselect();
  await page.getByRole("button", { name: "Get to know my space", exact: true }).click();
  await expect.poll(() => analysisStarted).toBe(true);
  expect(completed).toBe(true);
  expect(creations).toBe(1);
  expect(renewals).toBe(1);
  expect(resumedOffset).toBe(String(savedOffset));
  expect(resumedToken).toBe("renewed-token");
  expect(resumedBytes).toBe(size - savedOffset);
  expect(errors).toEqual([]);
});
