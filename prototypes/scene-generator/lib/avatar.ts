import * as THREE from "three";

// Analytic two-bone IK: preserve both segment lengths, or explicitly fail.
export function solveArm(
  shoulder: THREE.Vector3,
  wrist: THREE.Vector3,
  length: number,
) {
  const direction = wrist.clone().sub(shoulder);
  const distance = direction.length();
  if (distance < 0.001 || distance > 2 * length - 0.001) return null;
  direction.normalize();
  const bend = new THREE.Vector3(0, -1, 0);
  bend.addScaledVector(direction, -bend.dot(direction));
  if (bend.lengthSq() < 0.001)
    bend.set(0, 0, 1).addScaledVector(direction, -direction.z);
  bend.normalize();
  return shoulder
    .clone()
    .addScaledVector(direction, distance / 2)
    .addScaledVector(
      bend,
      Math.sqrt(length * length - (distance * distance) / 4),
    );
}

export function createAvatar(size: number, standingPosition: number[]) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: "#d5c7b5",
    roughness: 0.7,
  });
  const clothing = new THREE.MeshStandardMaterial({
    color: "#626ba0",
    roughness: 0.85,
  });
  const root = new THREE.Vector3(
    ...(standingPosition as [number, number, number]),
  );
  function mesh(
    geometry: THREE.BufferGeometry,
    position: THREE.Vector3,
    mat = material,
  ) {
    const part = new THREE.Mesh(geometry, mat);
    part.position.copy(position);
    group.add(part);
    return part;
  }
  const relative = (x: number, y: number, z: number) =>
    root.clone().add(new THREE.Vector3(x, y, z).multiplyScalar(size));
  mesh(new THREE.SphereGeometry(0.21 * size, 20, 16), relative(0, 2.02, 0));
  mesh(
    new THREE.CapsuleGeometry(0.29 * size, 0.46 * size, 4, 12),
    relative(0, 1.39, 0),
    clothing,
  );
  mesh(
    new THREE.CapsuleGeometry(0.095 * size, 0.7 * size, 4, 12),
    relative(-0.16, 0.46, 0),
    clothing,
  );
  mesh(
    new THREE.CapsuleGeometry(0.095 * size, 0.7 * size, 4, 12),
    relative(0.16, 0.46, 0),
    clothing,
  );
  mesh(
    new THREE.CapsuleGeometry(0.075 * size, 0.7 * size, 4, 12),
    relative(-0.38, 1.2, 0),
  );
  const shoulder = relative(0.34, 1.65, 0);
  const upper = mesh(
    new THREE.CylinderGeometry(0.075 * size, 0.065 * size, 1, 12),
    shoulder,
  );
  const lower = mesh(
    new THREE.CylinderGeometry(0.065 * size, 0.05 * size, 1, 12),
    shoulder,
  );
  const palm = mesh(new THREE.SphereGeometry(1, 16, 12), shoulder);
  palm.scale.set(0.085 * size, 0.11 * size, 0.045 * size);
  const joint = mesh(new THREE.SphereGeometry(0.076 * size, 12, 10), shoulder);
  const up = new THREE.Vector3(0, 1, 0);
  function segment(part: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3) {
    const delta = to.clone().sub(from);
    part.position.copy(from).add(to).multiplyScalar(0.5);
    part.scale.y = delta.length();
    part.quaternion.setFromUnitVectors(up, delta.normalize());
  }
  function update(target: THREE.Object3D, offset: number[]) {
    const contact = target.localToWorld(
      new THREE.Vector3(...(offset as [number, number, number])),
    );
    const elbow = solveArm(shoulder, contact, 0.95 * size);
    group.visible = Boolean(elbow);
    if (!elbow) return false;
    segment(upper, shoulder, elbow);
    segment(lower, elbow, contact);
    joint.position.copy(elbow);
    palm.position.copy(contact);
    target.getWorldQuaternion(palm.quaternion);
    return true;
  }
  function dispose() {
    group.traverse((part) => {
      if (part instanceof THREE.Mesh) part.geometry.dispose();
    });
    material.dispose();
    clothing.dispose();
  }
  return { group, update, dispose };
}
