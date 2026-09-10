import { Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import type { Vec3 } from "./contracts";

export type Correspondence = { id: string; world: Vec3; image: [number, number]; check?: boolean };
export type Calibration = {
  position: Vec3; quaternion: [number, number, number, number]; verticalFov: number;
  width: number; height: number; fitError: number; checkError: number; createdAt: number;
};

function eigenSymmetric(input: number[][]) {
  const n = input.length;
  const a = input.map(row => [...row]);
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1 : 0) as number[]);
  for (let iteration = 0; iteration < n * n * 80; iteration++) {
    let p = 0, q = 1, largest = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(a[i][j]) > largest) { largest = Math.abs(a[i][j]); p = i; q = j; }
    if (largest < 1e-12) break;
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let k = 0; k < n; k++) if (k !== p && k !== q) {
      const kp = a[k][p], kq = a[k][q];
      a[k][p] = a[p][k] = c * kp - s * kq;
      a[k][q] = a[q][k] = s * kp + c * kq;
    }
    const pp = a[p][p], qq = a[q][q], pq = a[p][q];
    a[p][p] = c * c * pp - 2 * s * c * pq + s * s * qq;
    a[q][q] = s * s * pp + 2 * s * c * pq + c * c * qq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < n; k++) { const vp = v[k][p], vq = v[k][q]; v[k][p] = c * vp - s * vq; v[k][q] = s * vp + c * vq; }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

function solveLinear(input: number[][], rhs: number[]) {
  const a = input.map((row, i) => [...row, rhs[i]]), n = rhs.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    if (Math.abs(a[i][i]) < 1e-14) return null;
    const scale = a[i][i];
    for (let k = i; k <= n; k++) a[i][k] /= scale;
    for (let j = 0; j < n; j++) if (j !== i) { const f = a[j][i]; for (let k = i; k <= n; k++) a[j][k] -= f * a[i][k]; }
  }
  return a.map(row => row[n]);
}

function rotation(parameters: number[]) {
  const axis = new Vector3(parameters[3], parameters[4], parameters[5]);
  const angle = axis.length();
  return new Quaternion().setFromAxisAngle(angle > 1e-10 ? axis.divideScalar(angle) : new Vector3(1, 0, 0), angle);
}

function project(parameters: number[], point: Vec3, width: number, height: number): [number, number, number] {
  const local = new Vector3(...point).sub(new Vector3(parameters[0], parameters[1], parameters[2])).applyQuaternion(rotation(parameters));
  const focal = Math.exp(parameters[6]) * Math.max(width, height);
  const depth = Math.max(local.z, 1e-5);
  return [width / 2 + focal * local.x / depth, height / 2 + focal * local.y / depth, local.z];
}

function residuals(parameters: number[], points: Correspondence[], width: number, height: number) {
  return points.flatMap(point => { const projected = project(parameters, point.world, width, height); return [projected[0] - point.image[0], projected[1] - point.image[1]]; });
}
function squareSum(values: number[]) { return values.reduce((sum, x) => sum + x * x, 0); }

/** Fits a pinhole camera; check landmarks never participate in optimization. */
export function calibrateCamera(points: Correspondence[], width: number, height: number): Calibration {
  const fit = points.filter(p => !p.check), checks = points.filter(p => p.check);
  if (fit.length < 6 || checks.length < 2) throw new Error("Match six landmarks and two independent check points.");
  if (width <= 0 || height <= 0 || points.some(p => [...p.world, ...p.image].some(v => !Number.isFinite(v)))) throw new Error("The camera measurements are invalid.");
  const center = new Vector3(); fit.forEach(p => center.add(new Vector3(...p.world))); center.divideScalar(fit.length);
  const covariance = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const p of fit) { const d = new Vector3(...p.world).sub(center).toArray(); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) covariance[i][j] += d[i] * d[j]; }
  const eigen = eigenSymmetric(covariance).values.sort((a, b) => a - b);
  if (eigen[2] < 1e-8 || eigen[0] / eigen[2] < .002) throw new Error("Choose landmarks at different heights and depths. These points are too flat to align the camera.");
  const spread = Math.sqrt((eigen[0] + eigen[1] + eigen[2]) / fit.length);
  const scale = Math.max(width, height);
  const rows: number[][] = [];
  for (const p of fit) {
    const [x, y, z] = new Vector3(...p.world).sub(center).divideScalar(spread).toArray();
    const u = (p.image[0] - width / 2) / scale, v = (p.image[1] - height / 2) / scale;
    rows.push([x, y, z, 1, 0, 0, 0, 0, -u * x, -u * y, -u * z, -u]);
    rows.push([0, 0, 0, 0, x, y, z, 1, -v * x, -v * y, -v * z, -v]);
  }
  const ata = Array.from({ length: 12 }, (_, i) => Array.from({ length: 12 }, (_, j) => rows.reduce((sum, row) => sum + row[i] * row[j], 0)));
  const decomposition = eigenSymmetric(ata);
  const minimum = decomposition.values.indexOf(Math.min(...decomposition.values));
  let p = decomposition.vectors.map(row => row[minimum]);
  let matrix = new Matrix3().set(p[0], p[1], p[2], p[4], p[5], p[6], p[8], p[9], p[10]);
  if (matrix.determinant() < 0) { p = p.map(v => -v); matrix = new Matrix3().set(p[0], p[1], p[2], p[4], p[5], p[6], p[8], p[9], p[10]); }
  if (Math.abs(matrix.determinant()) < 1e-12) throw new Error("The landmarks do not establish a camera position. Try a wider range of points.");
  const position = new Vector3(p[3], p[7], p[11]).applyMatrix3(matrix.clone().invert()).negate().multiplyScalar(spread).add(center);
  const r3 = new Vector3(p[8], p[9], p[10]); const rowScale = r3.length(); r3.normalize();
  const first = new Vector3(p[0], p[1], p[2]); first.addScaledVector(r3, -first.dot(r3));
  const focal = first.length() / rowScale;
  const r1 = first.normalize(), r2 = new Vector3().crossVectors(r3, r1).normalize();
  const rotationMatrix = new Matrix4().set(r1.x, r1.y, r1.z, 0, r2.x, r2.y, r2.z, 0, r3.x, r3.y, r3.z, 0, 0, 0, 0, 1);
  const quat = new Quaternion().setFromRotationMatrix(rotationMatrix).normalize();
  if (quat.w < 0) quat.set(-quat.x, -quat.y, -quat.z, -quat.w);
  const angle = 2 * Math.acos(Math.min(1, quat.w)), sin = Math.sqrt(1 - quat.w * quat.w);
  let parameters = [...position.toArray(), ...(sin > 1e-7 ? [quat.x / sin * angle, quat.y / sin * angle, quat.z / sin * angle] : [0, 0, 0]), Math.log(Math.max(.15, Math.min(5, focal)))];
  let lambda = .001;
  for (let iteration = 0; iteration < 100; iteration++) {
    const residual = residuals(parameters, fit, width, height);
    const jacobian = residual.map(() => Array(7).fill(0) as number[]);
    for (let j = 0; j < 7; j++) {
      const shifted = [...parameters]; const delta = 1e-6 * Math.max(1, Math.abs(parameters[j])); shifted[j] += delta;
      const next = residuals(shifted, fit, width, height);
      for (let i = 0; i < residual.length; i++) jacobian[i][j] = (next[i] - residual[i]) / delta;
    }
    const hessian = Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) => jacobian.reduce((sum, row) => sum + row[i] * row[j], 0)));
    const gradient = Array.from({ length: 7 }, (_, i) => -jacobian.reduce((sum, row, j) => sum + row[i] * residual[j], 0));
    for (let i = 0; i < 7; i++) hessian[i][i] += lambda * Math.max(hessian[i][i], 1);
    const step = solveLinear(hessian, gradient); if (!step) break;
    const candidate = parameters.map((value, i) => value + step[i]);
    candidate[6] = Math.max(Math.log(.15), Math.min(Math.log(5), candidate[6]));
    if (squareSum(residuals(candidate, fit, width, height)) < squareSum(residual)) { parameters = candidate; lambda /= 3; if (squareSum(step) < 1e-12) break; } else lambda *= 10;
  }
  if (points.some(point => project(parameters, point.world, width, height)[2] <= .03)) throw new Error("Some landmarks are behind the fitted camera. Recheck the highlighted points.");
  const fitError = Math.sqrt(squareSum(residuals(parameters, fit, width, height)) / fit.length);
  const checkError = Math.sqrt(squareSum(residuals(parameters, checks, width, height)) / checks.length);
  const threshold = Math.hypot(width, height) * .012;
  if (fitError > threshold || checkError > threshold) throw new Error("The check points do not line up yet. Keep the phone still and match the landmarks again.");
  const cvToThree = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
  const cameraQuaternion = rotation(parameters).invert().multiply(cvToThree);
  return { position: parameters.slice(0, 3) as Vec3, quaternion: cameraQuaternion.toArray() as [number, number, number, number], verticalFov: 2 * Math.atan(height / (2 * Math.exp(parameters[6]) * scale)) * 180 / Math.PI, width, height, fitError, checkError, createdAt: Date.now() };
}

export function projectLandmark(calibration: Calibration, world: Vec3): [number, number] {
  const local = new Vector3(...world).sub(new Vector3(...calibration.position)).applyQuaternion(new Quaternion(...calibration.quaternion).invert());
  const focal = calibration.height / (2 * Math.tan(calibration.verticalFov * Math.PI / 360));
  return [calibration.width / 2 + focal * local.x / -local.z, calibration.height / 2 - focal * local.y / -local.z];
}
