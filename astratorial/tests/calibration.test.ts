import { describe, expect, it } from "vitest";
import { calibrateCamera, projectLandmark, type Correspondence } from "../lib/calibration";
import { PerspectiveCamera, Vector3 } from "three";
import type { Vec3 } from "../lib/contracts";

const world: Vec3[] = [[-.6, .8, -.4], [.7, .8, -.3], [-.5, 1.6, -.5], [.5, 1.5, -.2], [-.3, 1.1, .5], [.6, 1.3, .6], [.1, 1.6, .2], [-.5, .9, .3]];
function fixture() {
  const camera = new PerspectiveCamera(52, 1280 / 720, .01, 100);
  camera.position.set(1.8, 2.1, 3.4); camera.lookAt(0, 1.1, 0); camera.updateMatrixWorld();
  return world.map((point, i): Correspondence => { const screen = new Vector3(...point).project(camera); return { id: String(i), world: point, image: [(screen.x + 1) * 640, (1 - screen.y) * 360], check: i >= 6 }; });
}
describe("camera calibration", () => {
  it("recovers a perspective camera from independent 3D landmarks", () => {
    const points = fixture(); const result = calibrateCamera(points, 1280, 720);
    expect(result.checkError).toBeLessThan(.1); expect(result.verticalFov).toBeCloseTo(52, 1);
    expect(result.position[0]).toBeCloseTo(1.8, 2);
    for (const p of points) { const image = projectLandmark(result, p.world); expect(Math.hypot(image[0] - p.image[0], image[1] - p.image[1])).toBeLessThan(.1); }
  });
  it("uses independent check points instead of fitting bad observations", () => {
    const points = fixture(); points[7].image[0] += 150;
    expect(() => calibrateCamera(points, 1280, 720)).toThrow(/check points/);
  });
  it("rejects a flat set even if it has enough points", () => {
    const points = fixture().map(p => ({ ...p, world: [p.world[0], 1, p.world[2]] as Vec3 }));
    expect(() => calibrateCamera(points, 1280, 720)).toThrow(/too flat/);
  });
  it("requires unused validation landmarks", () => {
    expect(() => calibrateCamera(fixture().map(p => ({ ...p, check: false })), 1280, 720)).toThrow(/check points/);
  });
});
