"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SceneObject, SceneSpec } from "@/lib/scene";

function geometry(shape: SceneObject["shape"]) {
  switch (shape) {
    case "box":
      return new THREE.BoxGeometry(1, 1, 1);
    case "sphere":
      return new THREE.SphereGeometry(1, 24, 16);
    case "cylinder":
      return new THREE.CylinderGeometry(1, 1, 1, 24);
    case "cone":
      return new THREE.ConeGeometry(1, 1, 24);
    case "torus":
      return new THREE.TorusGeometry(1, 0.08, 12, 48);
    case "capsule":
      return new THREE.CapsuleGeometry(0.5, 1, 4, 12);
    case "vessel":
      return new THREE.LatheGeometry(
        [
          new THREE.Vector2(0, 0),
          new THREE.Vector2(0.8, 0),
          new THREE.Vector2(1, 0.1),
          new THREE.Vector2(1, 1),
          new THREE.Vector2(0.9, 1),
          new THREE.Vector2(0.9, 0.15),
          new THREE.Vector2(0, 0.15),
        ],
        32,
      );
  }
}

export default function SceneViewer({
  scene,
  playing,
  resetKey,
}: {
  scene: SceneSpec;
  playing: boolean;
  resetKey: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const playingRef = useRef(playing);
  const [error, setError] = useState("");
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    const container = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      queueMicrotask(() =>
        setError(
          "3D rendering is unavailable. Try a browser with WebGL enabled.",
        ),
      );
      return;
    }
    queueMicrotask(() => setError(""));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(scene.background);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.4;
    container.appendChild(renderer.domElement);
    renderer.domElement.setAttribute(
      "aria-label",
      scene.title + ". Drag to rotate; scroll to zoom.",
    );
    renderer.domElement.setAttribute("role", "img");
    const world = new THREE.Scene();
    world.add(new THREE.HemisphereLight(0xcbd9ff, 0x343049, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 4);
    light.position.set(4, 8, 5);
    world.add(light);
    const rim = new THREE.DirectionalLight(0x9180ff, 2);
    rim.position.set(-5, 3, -4);
    world.add(rim);
    const content = new THREE.Group();
    world.add(content);
    const nodes = new Map<string, THREE.Group>();
    const meshes: THREE.Mesh[] = [];
    for (const object of scene.objects) {
      // Motion groups keep children together without multiplying their dimensions.
      const node = new THREE.Group();
      const mesh = new THREE.Mesh(
        geometry(object.shape),
        new THREE.MeshStandardMaterial({
          color: object.color,
          metalness: object.metalness,
          roughness: object.roughness,
          transparent: object.opacity < 1,
          opacity: object.opacity,
          side: THREE.DoubleSide,
          depthWrite: object.opacity === 1,
        }),
      );
      mesh.scale.set(...(object.scale as [number, number, number]));
      node.position.set(...(object.position as [number, number, number]));
      node.rotation.set(...(object.rotation as [number, number, number]));
      node.add(mesh);
      nodes.set(object.id, node);
      meshes.push(mesh);
    }
    for (const object of scene.objects)
      (object.parentId ? nodes.get(object.parentId)! : content).add(
        nodes.get(object.id)!,
      );
    const bounds = new THREE.Box3().setFromObject(content);
    const center = bounds.getCenter(new THREE.Vector3());
    const extent = Math.max(
      bounds.getSize(new THREE.Vector3()).length() / 2,
      2,
    );
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 2000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.copy(center);
    controls.minDistance = extent * 0.15;
    controls.maxDistance = extent * 10;
    const resize = () => {
      const width = Math.max(container.clientWidth, 1),
        height = Math.max(container.clientHeight, 1);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const distance =
      extent /
      Math.sin(THREE.MathUtils.degToRad(20)) /
      Math.min(camera.aspect, 1);
    camera.position
      .copy(center)
      .add(new THREE.Vector3(1, 0.7, 1.2).normalize().multiplyScalar(distance));
    controls.update();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    let elapsed = 0,
      previous = performance.now();
    const lost = (event: Event) => {
      event.preventDefault();
      setError(
        "The graphics context was lost. Use Reset view to reload the scene.",
      );
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    renderer.setAnimationLoop((now) => {
      const delta = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      if (playingRef.current) elapsed += delta;
      for (const object of scene.objects) {
        const node = nodes.get(object.id)!;
        const motion = object.motion;
        const axis = motion.axis;
        const index = { x: 0, y: 1, z: 2 }[axis];
        const phase = elapsed * motion.speed;
        if (motion.type === "spin")
          node.rotation[axis] = object.rotation[index] + phase;
        if (motion.type === "bob" || motion.type === "translate")
          node.position[axis] =
            object.position[index] +
            (motion.type === "translate"
              ? (1 + Math.cos(Math.min(phase, Math.PI))) / 2
              : Math.sin(phase)) *
              motion.amplitude;
        if (motion.type === "orbit") {
          const [a, b] =
            axis === "y"
              ? (["x", "z"] as const)
              : axis === "x"
                ? (["y", "z"] as const)
                : (["x", "y"] as const);
          const initial = Math.atan2(
            object.position[{ x: 0, y: 1, z: 2 }[b]],
            object.position[{ x: 0, y: 1, z: 2 }[a]],
          );
          node.position[a] = Math.cos(phase + initial) * motion.amplitude;
          node.position[b] = Math.sin(phase + initial) * motion.amplitude;
        }
      }
      controls.update();
      renderer.render(world, camera);
    });
    return () => {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      controls.dispose();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [scene, resetKey]);
  return (
    <div ref={host} className="scene-canvas">
      {error && (
        <div className="canvas-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
