import { expect, test } from "@playwright/test";
import type { CaptureAsset, Tutorial } from "../../lib/contracts";
import { getExample } from "../../lib/examples";

test("a video starts analysis without a goal or login and returns an editable inferred plan", async ({ page, baseURL }) => {
  const id = "55555555-5555-4555-8555-555555555555";
  const uploadId = "66666666-6666-4666-8666-666666666666";
  const endpoint = new URL("/fixture-upload-first", baseURL).href;
  const asset: CaptureAsset = { id: uploadId, path: `${id}/counter.webm`, name: "counter.webm", mimeType: "video/webm", size: 100, kind: "video", pass: "room" };
  const example = getExample("example-espresso")!;
  const blank: Tutorial = { ...example, id, title: "New tutorial", goal: "", constraints: [], referenceUrls: [], ownerId: "guest-owner", isExample: false, visibility: "private", status: "draft", plan: null, scene: null, job: null, assets: [], measurements: [] };
  const inferred: Tutorial = { ...blank, title: example.title, goal: "Make an espresso with the pod machine on my counter", assets: [asset], plan: { ...example.plan!, questions: [] } };
  const analysis = { id: "infer-job", kind: "analyze", status: "queued", progress: 0, message: "Looking at the counter", budgetUsd: 25, spentUsd: 0 };
  let guest = false;
  let analysisStarted = false;
  let generated = false;
  let submittedGoal: unknown = null;
  const order: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/config", route => route.fulfill({ json: { configured: true, generationMode: "illustrated", services: { database: true, openai: true, worker: true }, user: guest ? { id: "guest-owner", email: "" } : null } }));
  await page.route("**/api/auth/guest", route => { guest = true; order.push("guest"); return route.fulfill({ json: { user: { id: "guest-owner", email: "" } } }); });
  await page.route("**/api/tutorials", route => { submittedGoal = route.request().postDataJSON().goal; order.push("draft"); return route.fulfill({ json: { tutorial: blank } }); });
  await page.route("**/api/uploads?*", route => route.fulfill({ json: { uploads: [] } }));
  await page.route("**/api/uploads", route => { order.push("upload"); return route.fulfill({ json: { uploadId, asset, endpoint, headers: {}, metadata: {}, chunkSize: 6_291_456 } }); });
  await page.route("**/fixture-upload-first", route => route.fulfill({ status: 201, headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(asset.size), Location: `${endpoint}/file` } }));
  await page.route("**/api/uploads/complete", route => { order.push("complete"); return route.fulfill({ json: { tutorial: { ...blank, assets: [asset] }, asset } }); });
  await page.route(`**/api/tutorials/${id}/analyze`, route => { analysisStarted = true; order.push("analyze"); return route.fulfill({ json: { job: analysis } }); });
  await page.route("**/api/jobs/infer-job", route => route.fulfill({ json: { job: { ...analysis, status: "completed", progress: 100 }, tutorial: inferred } }));
  await page.route(`**/api/tutorials/${id}/generate`, route => { generated = true; return route.fulfill({ json: { job: { ...analysis, id: "generate-job", kind: "generate", stage: "animate" } } }); });
  await page.route("**/api/jobs/generate-job", route => route.fulfill({ json: { job: { ...analysis, id: "generate-job", kind: "generate", stage: "animate" } } }));

  await page.goto("/create");
  await expect(page.getByRole("heading", { name: "Start with a video." })).toBeVisible();
  await expect(page.getByLabel("What would you like to try?", { exact: false })).not.toBeVisible();
  await expect(page.getByText("Set the scene’s scale", { exact: true })).not.toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: asset.name, mimeType: asset.mimeType, buffer: Buffer.alloc(asset.size) });
  await expect.poll(() => analysisStarted).toBe(true);
  expect(submittedGoal).toBe("");
  expect(order).toEqual(["guest", "draft", "upload", "complete", "analyze"]);
  await expect(page.getByLabel("Your goal", { exact: false })).toHaveValue(inferred.goal);
  await expect(page.getByText("Things in your space", { exact: true })).toBeVisible();
  await expect(page.getByText(/Objects and distances are approximate/)).toBeVisible();
  await expect(page.getByText("Set the scene’s scale", { exact: true })).not.toBeVisible();
  await page.getByLabel("Your goal", { exact: false }).fill("Make a dairy-free coffee with this machine");
  await expect(page.getByRole("button", { name: "Update my plan", exact: false })).toBeEnabled();
  await page.getByLabel("Your goal", { exact: false }).fill(inferred.goal);
  await page.getByRole("button", { name: "Create my tutorial", exact: false }).click();
  await expect.poll(() => generated).toBe(true);
  expect(errors).toEqual([]);
});

test("oversized footage stays on the upload screen with a clear next action", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: { configured: true, generationMode: "illustrated", services: { database: true, openai: true, worker: true }, user: null } }));
  let guestRequests = 0;
  await page.route("**/api/auth/guest", route => { guestRequests++; return route.abort(); });
  await page.goto("/create");
  await page.locator('input[type="file"]').evaluate((input) => {
    const files = new DataTransfer();
    files.items.add(new File([new Uint8Array(50_000_001)], "too-long.mp4", { type: "video/mp4" }));
    (input as HTMLInputElement).files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator(".notice-error[role=alert]")).toContainText("Trim it to a short clip or record a new video here.");
  await expect(page.getByRole("button", { name: "Record a video", exact: true })).toBeEnabled();
  expect(guestRequests).toBe(0);
});
