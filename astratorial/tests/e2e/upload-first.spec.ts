import { expect, test } from "@playwright/test";
import type { CaptureAsset, GenerationJob, SceneManifest, Tutorial } from "../../lib/contracts";
import { getExample } from "../../lib/examples";

test("one video starts animation generation without login, a typed goal, or any follow-up", async ({ page, baseURL }) => {
  const id = "55555555-5555-4555-8555-555555555555";
  const uploadId = "66666666-6666-4666-8666-666666666666";
  const endpoint = new URL("/fixture-upload-first", baseURL).href;
  const asset: CaptureAsset = { id: uploadId, path: `${id}/counter.webm`, name: "counter.webm", mimeType: "video/webm", size: 100, kind: "video", pass: "room" };
  const example = getExample("example-espresso")!;
  const scene: SceneManifest = {
    mode: "illustrated", version: 1, units: "meters", durationSeconds: 10,
    assets: [{ path: `${id}/scene.glb`, kind: "scene", url: "/fixture-scene.glb" }],
    cameras: { first: { position: [0, 1.6, 1], target: [0, 1.1, 0] }, third: { position: [2, 2, 3], target: [0, 1, 0] } },
    bounds: { min: [-3, 0, -3], max: [3, 3, 3] }, landmarks: [], objects: [],
    steps: [{ stepId: example.plan!.steps[0].id, startTime: 0, endTime: 10, clipName: "tutorial" }],
    rig: { bodyNode: "TutorBody", handNodes: ["TutorHand_L", "TutorHand_R"] },
    quality: { approved: true, registeredFrameRatio: 0, medianReprojectionError: 0, measurementErrors: [], notes: ["Illustrated fixture"] }, sanitized: false,
  };
  const blank: Tutorial = { ...example, id, title: "New tutorial", goal: "", constraints: [], referenceUrls: [], ownerId: "guest-owner", isExample: false, visibility: "private", status: "draft", plan: null, scene: null, job: null, assets: [], measurements: [] };
  const inferred: Tutorial = { ...blank, title: example.title, goal: "Make an espresso with the pod machine on my counter", assets: [asset], plan: { ...example.plan!, questions: [] } };
  const generation = { id: "generate-job", kind: "generate", stage: "ingest", status: "queued", progress: 0, message: "Looking at the counter", budgetUsd: 25, spentUsd: 0 };
  let guest = false;
  let generationRequests = 0;
  let analysisRequests = 0;
  let finished = false;
  let polls = 0;
  let submittedGoal: unknown = null;
  const order: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/config", route => route.fulfill({ json: { configured: true, generationMode: "illustrated", services: { database: true, openai: true, worker: true }, user: guest ? { id: "guest-owner" } : null } }));
  await page.route("**/api/auth/guest", route => { guest = true; order.push("guest"); return route.fulfill({ json: { user: { id: "guest-owner" } } }); });
  await page.route("**/api/tutorials", route => { submittedGoal = route.request().postDataJSON().goal; order.push("draft"); return route.fulfill({ json: { tutorial: blank } }); });
  await page.route("**/api/uploads?*", route => route.fulfill({ json: { uploads: [] } }));
  await page.route("**/api/uploads", route => { order.push("upload"); return route.fulfill({ json: { uploadId, asset, endpoint, headers: {}, metadata: {}, chunkSize: 6_291_456 } }); });
  await page.route("**/fixture-upload-first", route => route.fulfill({ status: 201, headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(asset.size), Location: `${endpoint}/file` } }));
  await page.route("**/api/uploads/complete", route => { order.push("complete"); return route.fulfill({ json: { tutorial: { ...blank, assets: [asset] }, asset } }); });
  await page.route(`**/api/tutorials/${id}/analyze`, route => { analysisRequests++; return route.abort(); });
  await page.route(`**/api/tutorials/${id}/generate`, route => { generationRequests++; order.push("generate"); return route.fulfill({ json: { job: generation } }); });
  await page.route("**/api/jobs/generate-job", route => {
    polls++;
    return route.fulfill({ json: { job: { ...generation, status: finished ? "completed" : "running", stage: finished ? "ready" : "animate", progress: finished ? 100 : 50 }, tutorial: { ...inferred, status: finished ? "ready" : "generating", scene: finished ? scene : null } } });
  });

  await page.goto("/create");
  await expect(page.getByRole("heading", { name: "Start with a video." })).toBeVisible();
  await expect(page.getByLabel("What would you like to try?", { exact: false })).not.toBeVisible();
  await expect(page.getByText("Set the scene’s scale", { exact: true })).not.toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: asset.name, mimeType: asset.mimeType, buffer: Buffer.alloc(asset.size) });
  await expect.poll(() => generationRequests).toBe(1);
  expect(submittedGoal).toBeUndefined();
  expect(order).toEqual(["guest", "draft", "upload", "complete", "generate"]);
  await expect(page.getByRole("heading", { name: "Your animation is taking shape." })).toBeVisible();
  await expect.poll(() => polls).toBeGreaterThan(0);
  await expect(page.getByLabel("Your goal", { exact: false })).not.toBeVisible();
  await expect(page.locator("main textarea, main input:not([type=file])")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Create my tutorial|Update my plan|Add a little context/ })).toHaveCount(0);
  await expect(page.getByText("Confirm", { exact: true })).not.toBeVisible();
  await expect(page.getByText("Set the scene’s scale", { exact: true })).not.toBeVisible();
  finished = true;
  await expect(page.getByRole("link", { name: "Watch my tutorial" })).toHaveAttribute("href", `/tutorial/${id}/${inferred.slug}`);
  expect(generationRequests).toBe(1);
  expect(analysisRequests).toBe(0);
  expect(errors).toEqual([]);
});

test("reloading a running animation restores progress without enqueueing another job", async ({ page }) => {
  const example = getExample("example-espresso")!;
  const id = "77777777-7777-4777-8777-777777777777";
  const now = new Date().toISOString();
  const job: GenerationJob = { id: "88888888-8888-4888-8888-888888888888", tutorialId: id, revision: 1, kind: "generate", status: "running", stage: "animate", progress: 50, message: "Animating the steps from your video", budgetUsd: 25, spentUsd: 1, reservedUsd: 0, createdAt: now, updatedAt: now, error: null };
  const tutorial: Tutorial = { ...example, id, ownerId: "guest-owner", isExample: false, status: "generating", visibility: "private", job, scene: null };
  let newJobs = 0;
  await page.route("**/api/config", route => route.fulfill({ json: { configured: true, generationMode: "illustrated", services: { database: true, openai: true, worker: true }, user: { id: "guest-owner" } } }));
  await page.route(`**/api/tutorials/${id}`, route => route.fulfill({ json: { tutorial } }));
  await page.route("**/api/uploads?*", route => route.fulfill({ json: { uploads: [] } }));
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job, tutorial } }));
  await page.route(`**/api/tutorials/${id}/generate`, route => { newJobs++; return route.abort(); });
  await page.goto(`/create?id=${id}`);
  await expect(page.getByRole("heading", { name: "Your animation is taking shape." })).toBeVisible();
  await page.reload();
  await expect(page.getByText(job.message, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
  await expect(page.getByText("Confirm", { exact: true })).not.toBeVisible();
  expect(newJobs).toBe(0);
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
