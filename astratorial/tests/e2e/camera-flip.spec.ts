import { expect, test, type Page } from "@playwright/test";

type CameraFixture = {
  requests: { facing: string; audio: boolean; previousCameraStates: string[] }[];
  cameras: MediaStreamTrack[];
  microphones: MediaStreamTrack[];
  recorders: { recorder: MediaRecorder; stream: MediaStream; trackIds: string[] }[];
  pending: boolean;
  failNext: boolean;
  release: (() => Promise<void>) | null;
};

async function installCameraFixture(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // These are real browser media tracks and real recordings. Only physical device
  // acquisition is replaced, so a stopped/replaced recorder track still fails.
  await page.addInitScript(() => {
    const fixture: CameraFixture = { requests: [], cameras: [], microphones: [], recorders: [], pending: false, failNext: false, release: null };
    Object.assign(window, { __cameraFlipFixture: fixture });
    const NativeMediaRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends NativeMediaRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        fixture.recorders.push({ recorder: this, stream, trackIds: stream.getTracks().map(track => track.id) });
      }
    };
    async function acquire(constraints: MediaStreamConstraints, facing: string) {
      const tracks: MediaStreamTrack[] = [];
      if (constraints.video) {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d")!;
        let frame = 0;
        const paint = () => {
          context.fillStyle = facing === "user" ? "#d72a2a" : "#29b44b";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#ffffff";
          context.fillRect(20 + frame++ % 300, 30, 25, 25);
        };
        paint();
        const timer = window.setInterval(paint, 70);
        const track = canvas.captureStream(15).getVideoTracks()[0];
        const getSettings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...getSettings(), facingMode: facing, deviceId: `fixture-${facing}` });
        const stop = track.stop.bind(track);
        track.stop = () => { window.clearInterval(timer); stop(); };
        fixture.cameras.push(track);
        tracks.push(track);
      }
      if (constraints.audio) {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        await context.resume();
        const track = destination.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); oscillator.stop(); void context.close(); };
        fixture.microphones.push(track);
        tracks.push(track);
      }
      return new MediaStream(tracks);
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        const value = typeof constraints.video === "object" ? constraints.video.facingMode : undefined;
        const facing = typeof value === "string" || Array.isArray(value) ? value : typeof value === "object" ? value.exact ?? value.ideal ?? "environment" : "environment";
        const device = typeof constraints.video === "object" ? constraints.video.deviceId : undefined;
        const requestedDevice = typeof device === "string" ? device : device && !Array.isArray(device) ? device.exact ?? device.ideal : undefined;
        const cameraFacing = requestedDevice === "fixture-user" ? "user" : requestedDevice === "fixture-environment" ? "environment" : Array.isArray(facing) ? facing[0] : facing;
        fixture.requests.push({ facing: cameraFacing, audio: !!constraints.audio, previousCameraStates: fixture.cameras.map(track => track.readyState) });
        if (fixture.failNext) {
          fixture.failNext = false;
          throw new DOMException("Fixture camera cannot start", "NotReadableError");
        }
        if (fixture.pending) {
          fixture.pending = false;
          return new Promise<MediaStream>(resolve => {
            fixture.release = async () => { resolve(await acquire(constraints, cameraFacing)); };
          });
        }
        return acquire(constraints, cameraFacing);
      },
    });
  });
  // Keep the completed recording on the device. No upload or provider requests
  // are needed to inspect the one file emitted by the real MediaRecorder.
  await page.route("**/api/config", route => route.fulfill({ json: { configured: false, generationMode: "illustrated", services: { database: false, openai: false, worker: false }, user: null } }));
  await page.route("**/api/runtime", route => route.fulfill({ json: { worker: { status: "offline", message: "Test worker is offline." } } }));
  await page.goto("/create");
  await page.getByRole("button", { name: "Record a video", exact: true }).click();
  await expect(page.getByRole("button", { name: "Record", exact: true })).toBeEnabled();
  return { errors };
}

async function cameraFacing(page: Page) {
  return page.getByLabel("Camera preview").evaluate(element => ((element as HTMLVideoElement).srcObject as MediaStream)?.getVideoTracks()[0]?.getSettings().facingMode);
}

async function setNextCamera(page: Page, option: "pending" | "failNext") {
  await page.evaluate(option => { (window as unknown as { __cameraFlipFixture: CameraFixture }).__cameraFlipFixture[option] = true; }, option);
}

async function releaseCamera(page: Page) {
  await page.evaluate(async () => { await (window as unknown as { __cameraFlipFixture: CameraFixture }).__cameraFlipFixture.release?.(); });
}

async function recordedCameraColor(page: Page) {
  return page.evaluate(async () => {
    const fixture = (window as unknown as { __cameraFlipFixture: CameraFixture }).__cameraFlipFixture;
    const preview = document.createElement("video");
    preview.muted = true;
    preview.playsInline = true;
    preview.srcObject = fixture.recorders[0].stream;
    await preview.play();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(preview, preview.videoWidth / 2, preview.videoHeight / 2, 1, 1, 0, 0, 1, 1);
    const [red, green] = context.getImageData(0, 0, 1, 1).data;
    preview.pause();
    preview.srcObject = null;
    return red > green + 40 ? "front" : green > red + 40 ? "rear" : "blank";
  });
}

async function finishAndVerifySingleClip(page: Page) {
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await expect(page.getByLabel("Camera preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Save recording guided-scan-/ })).toHaveCount(1);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Save recording guided-scan-/ }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^guided-scan-\d+\.(webm|mp4)$/);
  const file = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of file!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).length).toBeGreaterThan(100);
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as { __cameraFlipFixture: CameraFixture }).__cameraFlipFixture;
    return {
      count: fixture.recorders.length,
      recorderState: fixture.recorders[0].recorder.state,
      tracksEnded: [...fixture.cameras, ...fixture.microphones, ...fixture.recorders[0].stream.getTracks()].every(track => track.readyState === "ended"),
    };
  })).toEqual({ count: 1, recorderState: "inactive", tracksEnded: true });
}

test("flips before and during recording while preserving the microphone and one video clip", async ({ page }) => {
  const fixture = await installCameraFixture(page);
  await expect.poll(() => cameraFacing(page)).toBe("environment");
  const flip = page.getByRole("button", { name: "Flip camera", exact: true });
  await flip.click();
  await expect.poll(() => cameraFacing(page)).toBe("user");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.locator(".recording-label")).toContainText("1s / 90s");
  await expect.poll(() => recordedCameraColor(page)).toBe("front");
  await setNextCamera(page, "pending");
  await flip.click();
  await expect(page.locator(".recording-label")).toContainText("Switching camera…");
  await expect(flip).toBeDisabled();
  await expect(page.getByRole("button", { name: "Finish recording", exact: true })).toBeEnabled();
  await releaseCamera(page);
  await expect.poll(() => cameraFacing(page)).toBe("environment");
  await expect(flip).toBeEnabled();
  await expect.poll(() => recordedCameraColor(page)).toBe("rear");
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as { __cameraFlipFixture: CameraFixture }).__cameraFlipFixture;
    const recording = fixture.recorders[0];
    return {
      requests: fixture.requests.map(request => ({ facing: request.facing, audio: request.audio })),
      releasedBeforeSwitch: fixture.requests.slice(1).every(request => request.previousCameraStates.every(state => state === "ended")),
      recording: recording.recorder.state,
      sameTracks: recording.stream.getTracks().every(track => recording.trackIds.includes(track.id) && track.readyState === "live"),
      separateCameraTrack: !fixture.cameras.includes(recording.stream.getVideoTracks()[0]),
      microphoneCount: fixture.microphones.length,
      sameMicrophone: recording.stream.getAudioTracks()[0] === fixture.microphones[0],
    };
  })).toEqual({ requests: [{ facing: "environment", audio: true }, { facing: "user", audio: false }, { facing: "environment", audio: false }], releasedBeforeSwitch: true, recording: "recording", sameTracks: true, separateCameraTrack: true, microphoneCount: 1, sameMicrophone: true });
  await expect(page.locator(".recording-label")).toContainText(/\d+s \/ 90s/);
  await page.screenshot({ path: test.info().outputPath("camera-flip-recording.png"), fullPage: true });
  await finishAndVerifySingleClip(page);
  expect(fixture.errors).toEqual([]);
});

test("a failed flip restores the previous camera and preserves the active recording", async ({ page }) => {
  const fixture = await installCameraFixture(page);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.locator(".recording-label")).toContainText("1s / 90s");
  await setNextCamera(page, "failNext");
  await page.getByRole("button", { name: "Flip camera", exact: true }).click();
  await expect(page.locator(".recorder-camera-notice")).toContainText(/couldn.t switch|unable to switch|could not switch/i);
  await expect.poll(() => cameraFacing(page)).toBe("environment");
  await expect(page.getByRole("button", { name: "Flip camera", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Finish recording", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => {
    const fixture = (window as unknown as { __cameraFlipFixture: CameraFixture }).__cameraFlipFixture;
    return { count: fixture.recorders.length, state: fixture.recorders[0].recorder.state, microphoneCount: fixture.microphones.length, microphoneState: fixture.microphones[0].readyState, requestedCameras: fixture.requests.map(request => request.facing) };
  })).toEqual({ count: 1, state: "recording", microphoneCount: 1, microphoneState: "live", requestedCameras: ["environment", "user", "environment"] });
  await finishAndVerifySingleClip(page);
  expect(fixture.errors).toEqual([]);
});

test("closing a pending camera flip releases the microphone and any camera that opens afterward", async ({ page }) => {
  const fixture = await installCameraFixture(page);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await setNextCamera(page, "pending");
  await page.getByRole("button", { name: "Flip camera", exact: true }).click();
  await expect(page.locator(".recording-label")).toContainText("Switching camera…");
  await page.getByRole("button", { name: "Close recorder", exact: true }).click();
  await expect(page.getByLabel("Camera preview")).toHaveCount(0);
  await releaseCamera(page);
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as { __cameraFlipFixture: CameraFixture }).__cameraFlipFixture;
    return { camerasOpened: fixture.cameras.length, allEnded: [...fixture.cameras, ...fixture.microphones, ...fixture.recorders[0].stream.getTracks()].every(track => track.readyState === "ended"), recorderState: fixture.recorders[0].recorder.state };
  })).toEqual({ camerasOpened: 2, allEnded: true, recorderState: "inactive" });
  await expect(page.getByRole("button", { name: /^Save recording guided-scan-/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record a video", exact: true })).toBeEnabled();
  expect(fixture.errors).toEqual([]);
});
