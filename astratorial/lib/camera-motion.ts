/** Background landmark patches detect a moved camera without treating a moving hand as camera motion. */
export type FramePatch = { x: number; y: number; values: number[] };
const RADIUS = 6;
function patch(data: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  if (x < RADIUS || y < RADIUS || x >= width - RADIUS || y >= height - RADIUS) return null;
  const values: number[] = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) { const i = ((Math.round(y) + dy) * width + Math.round(x) + dx) * 4; values.push(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114); }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const centered = values.map(value => value - mean);
  const magnitude = Math.sqrt(centered.reduce((a, b) => a + b * b, 0));
  return magnitude < 70 ? null : centered.map(value => value / magnitude);
}
export function capturePatches(image: ImageData, points: [number, number][]) {
  return points.flatMap(([x, y]) => { const values = patch(image.data, image.width, image.height, x, y); return values ? [{ x, y, values }] : []; });
}
export function cameraMoved(image: ImageData, reference: FramePatch[]) {
  const shifts: number[] = [];
  for (const item of reference) {
    let best = -1, shift = 0;
    for (let dy = -8; dy <= 8; dy += 2) for (let dx = -8; dx <= 8; dx += 2) {
      const values = patch(image.data, image.width, image.height, item.x + dx, item.y + dy);
      if (!values) continue;
      const correlation = values.reduce((sum, value, i) => sum + value * item.values[i], 0);
      if (correlation > best) { best = correlation; shift = Math.hypot(dx, dy); }
    }
    if (best > .68) shifts.push(shift);
  }
  if (reference.length < 3) return "insufficient" as const;
  if (shifts.length < Math.ceil(reference.length / 2)) return "lost" as const;
  shifts.sort((a, b) => a - b);
  return shifts[Math.floor(shifts.length / 2)] > 3 ? "moved" as const : "stable" as const;
}
