import { expect, test } from "@playwright/test";
import path from "node:path";
import type { Tutorial } from "../../lib/contracts";
import { getExample } from "../../lib/examples";

test("renews media after four minutes without downloading the loaded scene or losing position", async ({ page }) => {
  await page.clock.install();
  const id = "55555555-5555-4555-8555-555555555555";
  const example = getExample("example-espresso")!;
  let reads = 0;
  let sceneDownloads = 0;
  let revision = 1;
  let denied = false;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const tutorial = (): Tutorial => ({ ...example, id, ownerId: "fixture-owner", isExample: false, visibility: "private", revision, scene: {
    version: 1, units: "meters", durationSeconds: 10,
    assets: [
      { kind: "scene", path: "test/scene.glb", url: `/renewal-scene.glb?token=${reads}` },
      { kind: "detail", path: "test/detail.glb", url: `/renewal-detail.glb?token=${reads}` },
      { kind: "narration", path: "test/narration.wav", url: `/renewal-narration.wav?token=${reads}` },
      { kind: "video", path: "test/tutorial.mp4", url: `/renewal-video.mp4?token=${reads}` },
    ],
    cameras: { first: { position: [0, 1.6, 1], target: [0, 1.1, 0] }, third: { position: [2, 2, 3], target: [0, 1, 0] } },
    bounds: { min: [-3, 0, -3], max: [3, 3, 3] }, landmarks: [], objects: [],
    steps: [{ stepId: example.plan!.steps[0].id, startTime: 0, endTime: 10, clipName: "tutorial" }],
    rig: { bodyNode: "TutorBody", handNodes: ["TutorHand_L", "TutorHand_R"] },
    quality: { approved: true, registeredFrameRatio: 1, medianReprojectionError: .2, measurementErrors: [.01], notes: [] }, sanitized: false,
  } });

  // A silent PCM fixture allows the actual audio element to seek and reload.
  const audio = Buffer.alloc(44 + 12 * 8_000 * 2);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8_000, 24); audio.writeUInt32LE(16_000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  await page.route("**/api/config", route => route.fulfill({ json: { configured: true, services: { database: true, openai: true, worker: true }, user: { id: "fixture-owner" } } }));
  await page.route(`**/api/tutorials/${id}`, route => {
    reads++;
    return denied ? route.fulfill({ status: 403, json: { error: "Tutorial access ended" } }) : route.fulfill({ json: { tutorial: tutorial() } });
  });
  await page.route("**/renewal-scene.glb?*", route => { sceneDownloads++; return route.fulfill({ path: path.join(process.cwd(), "tests/fixtures/animated-scene.glb"), contentType: "model/gltf-binary" }); });
  await page.route("**/renewal-narration.wav?*", route => {
    // Storage serves byte ranges; without them Chrome treats this fixture as unseekable.
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
    return route.fulfill({ status: range ? 206 : 200, body: audio.subarray(start, end + 1), contentType: "audio/wav", headers: { "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${audio.length}` } : {}) } });
  });
  await page.goto(`/tutorial/${id}/your-everyday-espresso`);
  await expect(page.getByRole("button", { name: "More detail", exact: true })).toBeEnabled();
  await expect.poll(() => sceneDownloads).toBe(1);
  await expect(page.locator("audio")).toHaveJSProperty("duration", 12);
  const timeline = page.getByRole("slider", { name: "Tutorial timeline" });
  await timeline.fill("5");
  await expect(page.locator("audio")).toHaveJSProperty("currentTime", 5);
  const initialReads = reads;

  await page.clock.fastForward(240_001);
  await expect.poll(() => reads).toBe(initialReads + 1);
  await expect(page.locator("audio")).toHaveAttribute("src", `/renewal-narration.wav?token=${reads}`);
  await expect(page.getByTitle("Download narrated tutorial")).toHaveAttribute("href", `/renewal-video.mp4?token=${reads}`);
  await expect(timeline).toHaveValue("5");
  await expect(page.locator("audio")).toHaveJSProperty("duration", 12);
  await expect(page.locator("audio")).toHaveJSProperty("currentTime", 5);
  expect(sceneDownloads).toBe(1);

  revision = 2;
  await page.clock.fastForward(240_001);
  await expect.poll(() => reads).toBe(initialReads + 2);
  await expect(timeline).toHaveValue("0");
  await expect.poll(() => sceneDownloads).toBe(2);
  await expect(page.getByRole("button", { name: "More detail", exact: true })).toBeEnabled();

  denied = true;
  await page.clock.fastForward(240_001);
  await expect(page.getByText("Tutorial unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Tutorial access ended", { exact: true })).toBeVisible();
  await expect(page.locator("audio")).toHaveCount(0);
  expect(errors).toEqual([]);
});
