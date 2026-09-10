import { expect, test, type Page } from "@playwright/test";
import type { AppConfig, CaptureAsset, GenerationJob, SceneManifest, Tutorial } from "../../lib/contracts";
import { getExample } from "../../lib/examples";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function uploadFixture(page: Page, baseURL: string | undefined, delays: {
  config?: ReturnType<typeof gate>;
  authorization?: ReturnType<typeof gate>;
  transfer?: ReturnType<typeof gate>;
  confirmation?: ReturnType<typeof gate>;
  generation?: ReturnType<typeof gate>;
} = {}) {
  const id = "99999999-9999-4999-8999-999999999999";
  const uploadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const example = getExample("example-espresso")!;
  const endpoint = new URL("/fixture-upload-feedback", baseURL).href;
  const asset: CaptureAsset = { id: uploadId, path: `${id}/coffee-counter.webm`, name: "coffee-counter.webm", mimeType: "video/webm", size: 200, kind: "video", pass: "room" };
  const tutorial: Tutorial = { ...example, id, title: "New tutorial", goal: "", ownerId: "guest-owner", isExample: false, visibility: "private", status: "draft", plan: null, scene: null, job: null, assets: [], measurements: [] };
  const now = new Date().toISOString();
  const job: GenerationJob = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tutorialId: id, revision: 1, kind: "generate", status: "queued", stage: "ingest", progress: 0, message: "Your tutorial is waiting for the local worker.", budgetUsd: 25, spentUsd: 0, reservedUsd: 0, createdAt: now, updatedAt: now, error: null };
  const state = {
    configured: true,
    guestError: "",
    guest: false,
    guestRequests: 0,
    draftRequests: 0,
    uploadRequests: 0,
    generationRequests: 0,
    resumeRequests: 0,
    workerStatus: "ready" as "ready" | "offline",
    workerMessage: "Local processing is ready.",
    running: false,
    jobError: "",
    jobPolls: 0,
  };
  await page.route("**/api/config", async route => {
    await delays.config?.promise;
    const config: AppConfig = { configured: state.configured, generationMode: "illustrated", services: { database: state.configured, openai: true, worker: true }, user: state.guest ? { id: "guest-owner" } : null };
    await route.fulfill({ json: config });
  });
  await page.route("**/api/runtime", route => route.fulfill({ json: { worker: { status: state.workerStatus, message: state.workerMessage } } }));
  await page.route("**/api/auth/guest", route => {
    state.guestRequests++;
    if (state.guestError) return route.fulfill({ status: 503, json: { error: { code: "guest_session_disabled", message: state.guestError } } });
    state.guest = true;
    return route.fulfill({ json: { user: { id: "guest-owner" } } });
  });
  await page.route("**/api/tutorials", route => { state.draftRequests++; return route.fulfill({ json: { tutorial } }); });
  await page.route("**/api/uploads?*", route => route.fulfill({ json: { uploads: [] } }));
  await page.route("**/api/uploads", async route => {
    state.uploadRequests++;
    await delays.authorization?.promise;
    await route.fulfill({ json: { uploadId, asset, endpoint, headers: {}, metadata: {}, chunkSize: 6_291_456 } });
  });
  await page.route("**/fixture-upload-feedback", async route => {
    await delays.transfer?.promise;
    await route.fulfill({ status: 201, headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(asset.size), Location: `${endpoint}/file` } });
  });
  await page.route("**/api/uploads/complete", async route => {
    await delays.confirmation?.promise;
    await route.fulfill({ json: { tutorial: { ...tutorial, assets: [asset] }, asset } });
  });
  await page.route(`**/api/tutorials/${id}/generate`, async route => {
    state.generationRequests++;
    await delays.generation?.promise;
    await route.fulfill({ json: { job } });
  });
  await page.route(`**/api/jobs/${job.id}`, route => {
    state.jobPolls++;
    const current = state.jobError ? { ...job, status: "failed", stage: "analyze", progress: 12, error: state.jobError }
      : state.running ? { ...job, status: "running", stage: "analyze", progress: 12, message: "Finding your goal in the video and its audio." } : job;
    return route.fulfill({ json: { job: current } });
  });
  await page.route(`**/api/jobs/${job.id}/resume`, route => {
    state.resumeRequests++;
    state.jobError = "";
    state.running = true;
    return route.fulfill({ json: { job: { ...job, status: "running", stage: "analyze", progress: 12, message: "Finding your goal in the video and its audio." } } });
  });
  return {
    state,
    choose: () => page.getByLabel("Video file", { exact: true }).setInputFiles({ name: asset.name, mimeType: asset.mimeType, buffer: Buffer.alloc(asset.size) }),
    filename: asset.name,
  };
}

test("choosing a video while connection details load shows activity and starts automatically once ready", async ({ page, baseURL }) => {
  const config = gate();
  const fixture = await uploadFixture(page, baseURL, { config });
  await page.goto("/create");
  await fixture.choose();
  await expect(page.getByText(fixture.filename, { exact: true })).toBeVisible();
  await expect(page.getByText("Checking your connection…", { exact: true })).toBeVisible();
  expect(fixture.state.generationRequests).toBe(0);
  config.release();
  await expect.poll(() => fixture.state.generationRequests).toBe(1);
  await expect(page.getByText("Your tutorial is queued.", { exact: true })).toBeVisible();
  expect(fixture.state.guestRequests).toBe(1);
  expect(fixture.state.uploadRequests).toBe(1);
});

test("missing configuration explains the problem and lets a selected video continue after reconnecting", async ({ page, baseURL }) => {
  const fixture = await uploadFixture(page, baseURL);
  fixture.state.configured = false;
  await page.goto("/create");
  await fixture.choose();
  await expect(page.getByText(fixture.filename, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your video is ready.", exact: true })).toBeVisible();
  await expect(page.getByText(/Connect video storage before we can upload and analyze your video/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Check connection", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Analyze my video", exact: true })).toHaveCount(0);
  expect(fixture.state.guestRequests).toBe(0);
  fixture.state.configured = true;
  await page.getByRole("button", { name: "Check connection", exact: true }).click();
  await expect.poll(() => fixture.state.generationRequests).toBe(1);
  await expect(page.getByText("Your tutorial is queued.", { exact: true })).toBeVisible();
  expect(fixture.state.uploadRequests).toBe(1);
});

test("a guest workspace failure displays its actionable reason and retries the same chosen video", async ({ page, baseURL }) => {
  const fixture = await uploadFixture(page, baseURL);
  fixture.state.guestError = "Anonymous sign-ins are disabled. Enable Allow anonymous sign-ins in Supabase Authentication, then try again.";
  await page.goto("/create");
  await fixture.choose();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(fixture.state.guestError);
  await expect(page.getByText(fixture.filename, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  expect(fixture.state.uploadRequests).toBe(0);
  fixture.state.guestError = "";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => fixture.state.generationRequests).toBe(1);
  await expect(page.getByText("Your tutorial is queued.", { exact: true })).toBeVisible();
  expect(fixture.state.guestRequests).toBe(2);
  expect(fixture.state.draftRequests).toBe(1);
  expect(fixture.state.uploadRequests).toBe(1);
});

test("slow upload stages stay visible and a queued local worker is distinguished from active parsing", async ({ page, baseURL }) => {
  const authorization = gate(), transfer = gate(), confirmation = gate(), generation = gate();
  const fixture = await uploadFixture(page, baseURL, { authorization, transfer, confirmation, generation });
  fixture.state.workerStatus = "offline";
  fixture.state.workerMessage = "Local processing is stopped. Start the local worker to continue; your video will stay saved.";
  await page.goto("/create");
  await fixture.choose();
  await expect(page.getByText("Preparing your upload…", { exact: true })).toBeVisible();
  expect(fixture.state.generationRequests).toBe(0);
  authorization.release();
  await expect(page.getByText("Uploading your video…", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Video upload progress" })).toBeVisible();
  transfer.release();
  await expect(page.getByText("Confirming your video is saved…", { exact: true })).toBeVisible();
  confirmation.release();
  await expect(page.getByText("Starting your tutorial…", { exact: true })).toBeVisible();
  generation.release();
  await expect(page.getByText("Your tutorial is queued.", { exact: true })).toBeVisible();
  await expect(page.getByText(fixture.state.workerMessage, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generation", exact: true })).toBeEnabled();
  fixture.state.workerStatus = "ready";
  fixture.state.workerMessage = "Local processing is ready.";
  fixture.state.running = true;
  await expect(page.getByText("Finding your goal in the video and its audio.", { exact: true })).toBeVisible();
  await expect(page.getByText("Your tutorial is queued.", { exact: true })).not.toBeVisible();
  expect(fixture.state.generationRequests).toBe(1);
});

test("a failed analysis explains what happened and retries saved work without another upload", async ({ page, baseURL }) => {
  const fixture = await uploadFixture(page, baseURL);
  fixture.state.jobError = "The AI service is temporarily unavailable. Your video is saved; try again in a moment.";
  await page.goto("/create");
  await fixture.choose();
  await expect(page.getByRole("heading", { name: "Your tutorial needs attention.", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(fixture.state.jobError);
  await expect(page.getByText(fixture.filename, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Finding your goal in the video and its audio.", { exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(fixture.state.resumeRequests).toBe(1);
  expect(fixture.state.uploadRequests).toBe(1);
  expect(fixture.state.generationRequests).toBe(1);
});

test("an insecure phone connection retains the selected video and explains how to reconnect securely", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, "subtle", { configurable: true, value: undefined });
    Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: undefined });
  });
  const fixture = await uploadFixture(page, baseURL);
  await page.goto("/create");
  await fixture.choose();
  await expect(page.getByText(fixture.filename, { exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Open this app using HTTPS or localhost to upload securely.");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  expect(fixture.state.guestRequests).toBe(0);
  expect(fixture.state.uploadRequests).toBe(0);
  expect(errors).toEqual([]);
});

test("a completed job with a missing scene offers a bounded reload and opens only the recovered scene", async ({ page }) => {
  const example = getExample("example-espresso")!;
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const recoveredScene: SceneManifest = {
    mode: "illustrated", version: 1, units: "meters", durationSeconds: 10,
    assets: [{ path: `${id}/scene.glb`, kind: "scene", url: "/fixture-scene.glb" }],
    cameras: { first: { position: [0, 1.6, 1], target: [0, 1.1, 0] }, third: { position: [2, 2, 3], target: [0, 1, 0] } },
    bounds: { min: [-3, 0, -3], max: [3, 3, 3] }, landmarks: [], objects: [],
    steps: [{ stepId: example.plan!.steps[0].id, startTime: 0, endTime: 10, clipName: "tutorial" }],
    rig: { bodyNode: "TutorBody", handNodes: ["TutorHand_L", "TutorHand_R"] },
    quality: { approved: true, registeredFrameRatio: 0, medianReprojectionError: 0, measurementErrors: [], notes: ["Illustrated fixture"] }, sanitized: false,
  };
  const now = new Date().toISOString();
  const job: GenerationJob = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", tutorialId: id, revision: 1, kind: "generate", status: "completed", stage: "ready", progress: 100, message: "Completed", budgetUsd: 25, spentUsd: 1, reservedUsd: 0, createdAt: now, updatedAt: now, error: null };
  const tutorial: Tutorial = { ...example, id, ownerId: "guest-owner", isExample: false, visibility: "private", status: "ready", scene: null, job };
  let recovered = false;
  let polls = 0;
  await page.route("**/api/config", route => route.fulfill({ json: { configured: true, generationMode: "illustrated", services: { database: true, openai: true, worker: true }, user: { id: "guest-owner" } } }));
  await page.route("**/api/runtime", route => route.fulfill({ json: { worker: { status: "ready", message: "Local processing is ready." } } }));
  await page.route("**/api/uploads?*", route => route.fulfill({ json: { uploads: [] } }));
  await page.route(`**/api/tutorials/${id}`, route => route.fulfill({ json: { tutorial: { ...tutorial, scene: recovered ? recoveredScene : null } } }));
  await page.route(`**/api/jobs/${job.id}`, route => { polls++; return route.fulfill({ json: { job, tutorial } }); });
  await page.goto(`/create?id=${id}`);
  await expect(page.getByRole("heading", { name: "The playable scene isn’t available yet.", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Watch my tutorial", exact: true })).toHaveCount(0);
  expect(polls).toBe(3);
  recovered = true;
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("link", { name: "Watch my tutorial", exact: true })).toHaveAttribute("href", `/tutorial/${id}/${example.slug}`);
  expect(polls).toBe(4);
});

for (const failure of [
  { status: 401, code: "InvalidCompactJWS", message: "Upload permission expired or was denied." },
  { status: 403, code: "AccessDenied", message: "Upload permission expired or was denied." },
  { status: 400, code: "AccessDenied", message: "Upload permission expired or was denied." },
  { status: 413, code: "EntityTooLarge", message: "This video is too large for the upload service." },
  { status: 415, code: "UnsupportedMediaType", message: "The upload service couldn’t accept this video format." },
]) {
  test(`upload error ${failure.status}/${failure.code} explains the remedy without exposing service details`, async ({ page, baseURL }) => {
    const fixture = await uploadFixture(page, baseURL);
    await page.route("**/fixture-upload-feedback", route => route.fulfill({ status: failure.status, json: { code: failure.code, message: "private detail https://storage.example.test/private?token=do-not-show" } }));
    await page.goto("/create");
    await fixture.choose();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(failure.message);
    await expect(page.getByRole("main")).not.toContainText("do-not-show");
    await expect(page.getByRole("main")).not.toContainText("private detail");
    await expect(page.getByText(fixture.filename, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
    expect(fixture.state.generationRequests).toBe(0);
  });
}
