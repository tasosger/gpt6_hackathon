import { describe, expect, it } from "vitest";
import { cameraMoved, capturePatches } from "@/lib/camera-motion";

function frame(shiftX = 0, shiftY = 0, obscure = false) {
  const width = 120, height = 100;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x - shiftX, py = y - shiftY;
    const value = obscure ? 120 : ((px * 73856093 ^ py * 19349663) >>> 0) % 256;
    const index = (y * width + x) * 4;
    data[index] = data[index + 1] = data[index + 2] = value; data[index + 3] = 255;
  }
  return { data, width, height } as ImageData;
}
const points: [number, number][] = [[25,25],[60,25],[90,25],[25,70],[60,70],[90,70]];
describe("fixed-camera movement guard", () => {
  it("accepts unchanged landmarks and detects a coherent camera shift", () => {
    const patches = capturePatches(frame(), points);
    expect(patches).toHaveLength(6);
    expect(cameraMoved(frame(), patches)).toBe("stable");
    expect(cameraMoved(frame(6,4), patches)).toBe("moved");
  });
  it("reports obscured or textureless landmarks instead of guessing the phone is still", () => {
    expect(cameraMoved(frame(0,0,true), capturePatches(frame(),points))).toBe("lost");
    expect(cameraMoved(frame(), capturePatches(frame(0,0,true),points))).toBe("insufficient");
  });
  it("tolerates a hand obscuring a minority of the static landmarks", () => {
    const image = frame();
    for (let y = 12; y < 39; y++) for (let x = 12; x < 39; x++) {
      const i = (y * image.width + x) * 4; image.data[i] = image.data[i+1] = image.data[i+2] = 100;
    }
    expect(cameraMoved(image, capturePatches(frame(), points))).toBe("stable");
  });
});
