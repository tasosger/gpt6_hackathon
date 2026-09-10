import { expect, test } from "@playwright/test";
import path from "node:path";
import { getExample } from "../../lib/examples";
import type { PracticeSession, Tutorial } from "../../lib/contracts";

test("positions illustrated ghost hands without landmarks, checks a step, and resets alignment when the phone turns", async ({ page }) => {
  const id = "77777777-7777-4777-8777-777777777777";
  const example = getExample("example-espresso")!;
  const tutorial: Tutorial = { ...example, id, ownerId: "fixture-owner", isExample: false, scene: {
    version: 1, units: "meters", mode: "illustrated", durationSeconds: 60,
    cameras: { first: { position: [0, 1.6, 1], target: [0, 1.1, 0] }, third: { position: [2, 2, 3], target: [0, 1, 0] } },
    bounds: { min: [-3, 0, -3], max: [3, 3, 4] },
    quality: { approved: true, registeredFrameRatio: 0, medianReprojectionError: 0, measurementErrors: [], notes: ["Illustrated fixture"] }, sanitized: false,
    assets: [{ kind: "scene", path: "test/illustrated.glb", url: "/illustrated-fixture.glb" }],
    landmarks: [],
    objects: [{ id: example.plan!.steps[0].objectIds[0], nodeName: "Cup", position: [0, 1, 0], movable: true, anchors: [] }],
    steps: example.plan!.steps.map((step, i) => ({ stepId: step.id, startTime: i * 10, endTime: (i + 1) * 10, clipName: "tutorial" })),
    rig: { bodyNode: "TutorBody", handNodes: ["TutorHand_L", "TutorHand_R"] },
  }};
  let session: PracticeSession = { id: "illustrated-practice", ownerId: "fixture-owner", tutorialId: id, tutorialRevision: 1, currentStepIndex: 0, version: 0, status: "calibrating", completedStepIds: [], consecutiveComplete: 0, calibration: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const actions: string[] = [];
  const errors: string[] = [];
  let checks = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /shader|WebGLProgram/.test(message.text())) errors.push(message.text()); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext("2d")!; const image = ctx.createImageData(1280, 720);
      for (let y = 0; y < 720; y++) for (let x = 0; x < 1280; x++) { const i = (y * 1280 + x) * 4; const v = ((Math.floor(x / 4) * 73856093 ^ Math.floor(y / 4) * 19349663) >>> 0) % 256; image.data[i] = image.data[i + 1] = image.data[i + 2] = v; image.data[i + 3] = 255; }
      ctx.putImageData(image, 0, 0); const stream = canvas.captureStream(5);
      const timer = setInterval(() => ctx.putImageData(image, 0, 0), 200); stream.getVideoTracks()[0].addEventListener("ended", () => clearInterval(timer));
      return stream;
    }});
  });
  await page.route("**/api/config", route => route.fulfill({ json: { configured: true, generationMode: "illustrated", services: { database: true, openai: true, worker: true }, user: { id: "fixture-owner", email: "" } } }));
  await page.route(`**/api/tutorials/${id}`, route => route.fulfill({ json: { tutorial } }));
  await page.route("**/illustrated-fixture.glb", route => route.fulfill({ path: path.join(process.cwd(), "tests/fixtures/animated-scene.glb"), contentType: "model/gltf-binary" }));
  await page.route("**/api/practice", route => route.fulfill({ json: { session } }));
  await page.route("**/api/practice/illustrated-practice", route => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON(); actions.push(body.action);
      expect(body.version).toBe(session.version);
      session = { ...session, version: session.version + 1 };
      if (body.action === "start_illustrated") session = { ...session, status: "active", calibration: { mode: "illustrated" } };
      if (body.action === "invalidate") session = { ...session, status: "calibrating", calibration: null };
      if (body.action === "pause") session.status = "paused";
      if (["resume", "repeat"].includes(body.action)) session.status = "active";
      if (body.action === "confirm") session.currentStepIndex++;
    }
    return route.fulfill({ json: { session } });
  });
  await page.route("**/api/practice/illustrated-practice/check", route => {
    const body = route.request().postDataJSON();
    expect(body.frames[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.version).toBe(session.version);
    checks++; session = { ...session, version: session.version + 1 };
    return route.fulfill({ json: { session, check: { stepId: tutorial.plan!.steps[0].id, status: "incomplete", guidance: "Place the cup under the spout.", evidence: "The cup is beside the machine." } } });
  });

  await page.goto(`/tutorial/${id}/espresso/practice`);
  await expect(page.getByRole("heading", { name: "Line it up with your workspace." })).toBeVisible();
  await expect(page.getByText("Match the landmarks.", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Open my camera" }).click();
  await expect(page.locator(".ghost-layer canvas")).toBeVisible();
  const drag = page.getByRole("group", { name: "Position illustrated guide" });
  await drag.focus(); await page.keyboard.press("ArrowRight");
  await expect(page.locator(".ghost-transform")).toHaveAttribute("style", /translate\(2%, 0%\)/);
  await page.getByRole("slider", { name: "Guide size" }).fill("1.8");
  await page.getByRole("button", { name: "Guide is aligned", exact: true }).click();
  await expect(page.getByRole("button", { name: "I’ve done this", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Locate.*object/ })).not.toBeVisible();
  await page.getByRole("checkbox", { name: "Check progress automatically" }).uncheck();
  await page.getByRole("button", { name: "Check this step", exact: true }).click();
  await expect(page.getByText("Place the cup under the spout.", { exact: true })).toBeVisible();
  expect(checks).toBe(1); expect(session.currentStepIndex).toBe(0);
  await page.getByRole("button", { name: "Pause guidance" }).click();
  await expect(page.getByRole("button", { name: "I’ve done this", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Resume guidance" }).click();
  await page.getByRole("button", { name: "I’ve done this", exact: true }).click();
  await expect.poll(() => session.currentStepIndex).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
  await expect(page.getByRole("button", { name: "Guide is aligned", exact: true })).toBeVisible();
  await expect.poll(() => session.status).toBe("calibrating");
  expect(actions).toContain("start_illustrated"); expect(actions).not.toContain("calibrate");
  await page.getByRole("button", { name: "Turn off camera" }).click();
  await expect(page.getByRole("button", { name: "Open my camera" })).toBeVisible();
  expect(errors).toEqual([]);
});
