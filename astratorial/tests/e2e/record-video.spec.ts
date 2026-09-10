import { expect, test } from "@playwright/test";
import type { CaptureAsset, GenerationJob, Tutorial } from "../../lib/contracts";
import { getExample } from "../../lib/examples";

test("finishing a camera recording automatically builds one animation and releases camera and microphone", async ({ page, baseURL }) => {
  const id = "99999999-9999-4999-8999-999999999999";
  const uploadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const endpoint = new URL("/fixture-recording-upload", baseURL).href;
  const now = new Date().toISOString();
  const example = getExample("example-espresso")!;
  const tutorial: Tutorial = { ...example, id, ownerId: "recording-owner", title: "New tutorial", goal: "", constraints: [], referenceUrls: [], isExample: false, visibility: "private", status: "draft", assets: [], measurements: [], plan: null, scene: null, job: null };
  const job: GenerationJob = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tutorialId: id, revision: 1, kind: "generate", status: "queued", stage: "ingest", progress: 0, message: "Reading your recorded video", budgetUsd: 25, spentUsd: 0, reservedUsd: 0, createdAt: now, updatedAt: now, error: null };
  let asset: CaptureAsset | null = null;
  let guest = false;
  let generationRequests = 0;
  let analysisRequests = 0;
  let jobPolls = 0;
  let uploadedBytes = 0;
  const order: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));

  // Exercise the real MediaRecorder with real video/audio tracks, without physical devices.
  await page.addInitScript(() => {
    const fixture = { requests: [] as MediaStreamConstraints[], tracks: [] as MediaStreamTrack[], stops: [] as string[] };
    Object.assign(window, { __recordingFixture: fixture });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        fixture.requests.push(constraints);
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d")!;
        let frame = 0;
        const paint = () => {
          context.fillStyle = "#536941";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#eedbc0";
          context.fillRect(20 + frame++ % 300, 90, 120, 80);
        };
        paint();
        const timer = window.setInterval(paint, 80);
        const camera = canvas.captureStream(12);
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        oscillator.frequency.value = 220;
        oscillator.connect(destination);
        oscillator.start();
        await audio.resume();
        const tracks = [...camera.getVideoTracks(), ...destination.stream.getAudioTracks()];
        fixture.tracks.push(...tracks);
        for (const track of tracks) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            fixture.stops.push(track.kind);
            stop();
            if (tracks.every(item => item.readyState === "ended")) {
              window.clearInterval(timer);
              oscillator.stop();
              void audio.close();
            }
          };
        }
        return new MediaStream(tracks);
      },
    });
  });
  await page.route("**/api/config", route => route.fulfill({ json: { configured: true, generationMode: "illustrated", services: { database: true, openai: true, worker: true }, user: guest ? { id: "recording-owner" } : null } }));
  await page.route("**/api/auth/guest", route => { guest = true; order.push("guest"); return route.fulfill({ json: { user: { id: "recording-owner" } } }); });
  await page.route("**/api/tutorials", route => {
    expect(route.request().postDataJSON().goal).toBeUndefined();
    order.push("draft");
    return route.fulfill({ json: { tutorial } });
  });
  await page.route("**/api/uploads?*", route => route.fulfill({ json: { uploads: [] } }));
  await page.route("**/api/uploads", route => {
    const input = route.request().postDataJSON();
    expect(input.kind).toBe("video");
    expect(input.mimeType).toMatch(/^video\//);
    expect(input.name).toMatch(/^guided-scan-\d+\.(webm|mp4)$/);
    expect(input.size).toBeGreaterThan(0);
    asset = { id: uploadId, path: `${id}/${input.name}`, name: input.name, mimeType: input.mimeType, size: input.size, kind: "video", pass: "room" };
    order.push("upload");
    return route.fulfill({ json: { uploadId, asset, endpoint, headers: {}, metadata: {}, chunkSize: 6_291_456 } });
  });
  await page.route("**/fixture-recording-upload", route => {
    uploadedBytes = route.request().postDataBuffer()?.length ?? 0;
    return route.fulfill({ status: 201, headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(asset!.size), Location: `${endpoint}/file` } });
  });
  await page.route("**/api/uploads/complete", route => { order.push("complete"); return route.fulfill({ json: { tutorial: { ...tutorial, assets: [asset] }, asset } }); });
  await page.route(`**/api/tutorials/${id}/analyze`, route => { analysisRequests++; return route.abort(); });
  await page.route(`**/api/tutorials/${id}/generate`, route => { generationRequests++; order.push("generate"); return route.fulfill({ json: { job } }); });
  await page.route(`**/api/jobs/${job.id}`, route => { jobPolls++; return route.fulfill({ json: { job: { ...job, status: "running", stage: "analyze", progress: 10 }, tutorial: { ...tutorial, status: "generating", assets: [asset] } } }); });

  await page.goto("/create");
  await page.getByRole("button", { name: "Record a video", exact: true }).click();
  await expect(page.getByLabel("Camera preview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Record", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.locator(".recording-label")).toContainText("1s / 90s");
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();

  await expect.poll(() => generationRequests).toBe(1);
  await expect(page.getByRole("heading", { name: "Your animation is taking shape." })).toBeVisible();
  await expect.poll(() => jobPolls).toBeGreaterThan(0);
  expect(order).toEqual(["guest", "draft", "upload", "complete", "generate"]);
  expect(uploadedBytes).toBe(asset!.size);
  expect(generationRequests).toBe(1);
  expect(analysisRequests).toBe(0);
  await expect(page.getByLabel("Camera preview")).toHaveCount(0);
  await expect(page.locator("main textarea, main input:not([type=file])")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Use (this|my) (video|recording)|Confirm|Create my tutorial|Add a little context/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as { __recordingFixture: { requests: MediaStreamConstraints[]; tracks: MediaStreamTrack[]; stops: string[] } }).__recordingFixture;
    return { hasAudioRequest: fixture.requests.every(request => request.audio === true), kinds: [...new Set(fixture.tracks.map(track => track.kind))].sort(), allEnded: fixture.tracks.every(track => track.readyState === "ended"), stoppedKinds: [...new Set(fixture.stops)].sort() };
  })).toEqual({ hasAudioRequest: true, kinds: ["audio", "video"], allEnded: true, stoppedKinds: ["audio", "video"] });
  expect(errors).toEqual([]);
});
