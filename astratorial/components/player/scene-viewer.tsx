"use client";

import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { ContactShadows, Html, OrbitControls, RoundedBox } from "@react-three/drei";
import { AnimationMixer, DoubleSide, Group, Mesh, MeshStandardMaterial, Vector3, Quaternion, Color, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { createScenePipeline, installSceneLighting } from "@/lib/scene-lighting";
import type { SceneManifest, Tutorial, Vec3 } from "@/lib/contracts";
import type { Calibration } from "@/lib/calibration";

export type CameraMode = "third" | "first" | "free";
type ObjectAnchors = Record<string, {position: Vec3; stepId: string}>;
type SceneViewerProps = { tutorial: Tutorial; time: number; mode: CameraMode; ghost?: boolean; calibration?: Calibration | null; landmarkIndex?: number; opacity?: number; objectAnchors?: ObjectAnchors; detailed?: boolean; onReady?: () => void; onError?: (message: string) => void };

class SceneBoundary extends Component<{ children: ReactNode; onError?: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError?.(error.message); }
  render() { return this.state.failed ? <div className="scene-unavailable"><span>Scene couldn’t load</span><p>Check your connection and reload the tutorial.</p><button onClick={() => window.location.reload()}>Reload scene</button></div> : this.props.children; }
}

function StudioLight() {
  const { gl, scene, camera, size } = useThree();
  useEffect(() => installSceneLighting(gl, scene), [gl, scene]);
  // Ambient occlusion, MSAA and tone mapping run through one composer; it replaces the default render.
  const pipeline = useMemo(() => createScenePipeline(gl, scene, camera, size.width, size.height), [gl, scene, camera]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { pipeline.setSize(size.width, size.height); }, [pipeline, size.width, size.height]);
  useEffect(() => () => pipeline.dispose(), [pipeline]);
  useFrame(() => pipeline.render(), 1);
  return null;
}

function RecordedScene({ manifest, time, ghost, opacity, objectAnchors, detailed, onReady }: { manifest: SceneManifest; time: number; ghost: boolean; opacity: number; objectAnchors?: ObjectAnchors; detailed?: boolean; onReady?: () => void }) {
  const { gl } = useThree();
  const asset = (detailed && manifest.assets.find(a => a.kind === "detail")) || manifest.assets.find(a => a.kind === "scene" || a.kind === "sanitized_scene");
  const gltf = useLoader(GLTFLoader, asset?.url || "", loader => {
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.setKTX2Loader(new KTX2Loader().setTranscoderPath("/basis/").detectSupport(gl));
  });
  const scene = useMemo(() => {
    const object = clone(gltf.scene);
    const handRoots = new Set(manifest.rig.handNodes);
    object.traverse(node => {
      if (!(node instanceof Mesh)) return;
      node.castShadow = true; node.receiveShadow = true;
      node.material = Array.isArray(node.material) ? node.material.map(m => m.clone()) : node.material.clone();
      if (ghost) {
        let ancestor: Object3D | null = node;
        let visible = false;
        let handNode = "";
        while (ancestor) { if (handRoots.has(ancestor.name)) { visible = true; handNode = ancestor.name; } ancestor = ancestor.parent; }
        node.visible = visible;
        node.userData.ghostHandNode = handNode;
        node.userData.ghostOffset = { value: new Vector3() };
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) if (material instanceof MeshStandardMaterial) {
          material.color = new Color("#99f6e4"); material.emissive = new Color("#0f766e"); material.emissiveIntensity = .35; material.transparent = true; material.opacity = opacity; material.depthWrite = false;
          material.onBeforeCompile = shader => {
            shader.uniforms.ghostOffset = node.userData.ghostOffset;
            shader.vertexShader = "uniform vec3 ghostOffset;\n" + shader.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\nmvPosition.xyz += (viewMatrix * vec4(ghostOffset, 0.0)).xyz;\ngl_Position = projectionMatrix * mvPosition;");
          };
          material.customProgramCacheKey = () => "astratorial-ghost-offset-v1";
        }
      }
    });
    return object;
  }, [gltf.scene, manifest.rig.handNodes, ghost, opacity]);
  const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
  useEffect(() => { onReady?.(); }, [gltf, onReady]);
  // Three.js cameras are imperative objects owned by the renderer, not React state.
  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    for (const clip of gltf.animations) mixer.clipAction(clip).play();
    return () => { mixer.stopAllAction(); mixer.uncacheRoot(scene); };
  }, [gltf.animations, mixer, scene]);
  useEffect(() => () => { scene.traverse(node => { if (node instanceof Mesh) (Array.isArray(node.material) ? node.material : [node.material]).forEach(m => m.dispose()); }); }, [scene]);
  useFrame(() => {
    mixer.setTime(time);
    if (!ghost) return;
    const step = manifest.steps.find(s => time >= s.startTime && time < s.endTime);
    scene.traverse(node => {
      if (!(node instanceof Mesh) || !node.userData.ghostOffset) return;
      const delta: Vector3 = node.userData.ghostOffset.value;
      delta.set(0, 0, 0);
      const target = step?.handTargets?.find(t => t.nodeName === node.userData.ghostHandNode);
      const anchor = target && objectAnchors?.[target.objectId];
      const original = target && manifest.objects.find(o => o.id === target.objectId);
      if (anchor && original && anchor.stepId === step?.stepId) {
        delta.set(...anchor.position).sub(new Vector3(...original.position));
        if (delta.length() > .15 || Math.abs(delta.y) > .02) delta.set(0, 0, 0);
      }
    });
  });
  return <primitive object={scene} />;
}

function CameraRig({ mode, manifest, calibration }: { mode: CameraMode; manifest: SceneManifest | null; calibration?: Calibration | null }) {
  const { camera } = useThree();
  const start = mode === "first" ? manifest?.cameras.first : manifest?.cameras.third;
  const position: Vec3 = start?.position ?? (mode === "first" ? [0, 1.64, 1.05] : [2.4, 2.15, 2.8]);
  const target: Vec3 = start?.target ?? [0, 1.05, 0];
  useEffect(() => {
    if (calibration) {
      camera.position.set(...calibration.position); camera.quaternion.set(...calibration.quaternion);
      if ("fov" in camera) { camera.fov = calibration.verticalFov; camera.updateProjectionMatrix(); }
      return;
    }
    camera.position.set(...position); camera.lookAt(...target);
    if ("fov" in camera) { camera.fov = mode === "first" ? 60 : 42; camera.updateProjectionMatrix(); }
    // Stable tuple components avoid resetting an orbit when the timeline moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, calibration, camera, ...position, ...target]);
  /* eslint-enable react-hooks/immutability */
  if (calibration || mode !== "free") return null;
  const bounds = manifest?.bounds ?? { min: [-3, .3, -2] as Vec3, max: [3, 3, 4] as Vec3 };
  return <OrbitControls makeDefault target={target} minDistance={.35} maxDistance={4} maxPolarAngle={Math.PI / 2.05} onChange={() => { camera.position.clamp(new Vector3(...bounds.min), new Vector3(...bounds.max)); }} />;
}

function CapsuleBetween({ from, to, radius, color, ghost = false }: { from: Vec3; to: Vec3; radius: number; color: string; ghost?: boolean }) {
  const { position, quaternion, length } = useMemo(() => {
    const a = new Vector3(...from), b = new Vector3(...to), vector = b.clone().sub(a);
    return { position: a.add(b).multiplyScalar(.5), quaternion: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), vector.clone().normalize()), length: vector.length() };
  }, [from, to]);
  return <mesh position={position} quaternion={quaternion} castShadow><capsuleGeometry args={[radius, Math.max(.001, length - radius * 2), 6, 12]} /><meshStandardMaterial color={color} roughness={.75} transparent={ghost} opacity={ghost ? .65 : 1} /></mesh>;
}

function Hand({ position, ghost }: { position: Vec3; ghost: boolean }) {
  return <group position={position} rotation={[0, .3, -.15]}>
    <RoundedBox args={[.078, .028, .082]} radius={.013} smoothness={3} castShadow><meshStandardMaterial color={ghost ? "#99f6e4" : "#bf8b6b"} transparent={ghost} opacity={ghost ? .65 : 1} roughness={.72} /></RoundedBox>
    {[0, 1, 2, 3].map(i => <group key={i} position={[(i - 1.5) * .019, 0, -.057]} rotation={[-.15 - i * .05, 0, 0]}><CapsuleBetween from={[0, 0, 0]} to={[0, -.007, -.065 + Math.abs(i - 1) * .01]} radius={.008} color={ghost ? "#99f6e4" : "#bf8b6b"} ghost={ghost} /></group>)}
    <CapsuleBetween from={[-.034, 0, .013]} to={[-.061, -.014, -.023]} radius={.009} color={ghost ? "#99f6e4" : "#bf8b6b"} ghost={ghost} />
  </group>;
}

function Cup({ position = [0, 0, 0] }: { position?: Vec3 }) {
  return <group position={position}>
    <mesh castShadow><cylinderGeometry args={[.064, .047, .097, 40, 1, true]} /><meshStandardMaterial color="#e9dfc9" roughness={.28} side={DoubleSide} /></mesh>
    <mesh position={[0, -.047, 0]}><cylinderGeometry args={[.047, .047, .007, 32]} /><meshStandardMaterial color="#e9dfc9" /></mesh>
    <mesh position={[0, .049, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[.061, .004, 8, 40]} /><meshStandardMaterial color="#f0e6d4" /></mesh>
    <mesh position={[.075, .003, 0]}><torusGeometry args={[.031, .008, 10, 24, Math.PI * 1.65]} /><meshStandardMaterial color="#e9dfc9" roughness={.3} /></mesh>
    <mesh position={[0, .035, 0]}><cylinderGeometry args={[.059, .059, .002, 32]} /><meshStandardMaterial color="#a76a31" roughness={.35} /></mesh>
  </group>;
}

function Machine() {
  return <group position={[-.14, .95, -.1]}>
    <RoundedBox args={[.29, .38, .42]} radius={.045} smoothness={6} position={[0, .2, 0]} castShadow receiveShadow><meshStandardMaterial color="#989b98" metalness={.9} roughness={.26} /></RoundedBox>
    <RoundedBox args={[.23, .24, .045]} radius={.025} position={[0, .2, .223]} castShadow><meshStandardMaterial color="#222522" roughness={.32} metalness={.25} /></RoundedBox>
    <RoundedBox args={[.29, .035, .52]} radius={.024} position={[0, .008, .04]} castShadow><meshStandardMaterial color="#adb0aa" metalness={.85} roughness={.26} /></RoundedBox>
    <mesh position={[0, .298, .256]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[.09, .09, .044, 40]} /><meshStandardMaterial color="#c6c8c0" metalness={.88} roughness={.22} /></mesh>
    <mesh position={[0, .209, .275]} castShadow><cylinderGeometry args={[.009, .008, .035, 16]} /><meshStandardMaterial color="#b8b8af" metalness={1} roughness={.2} /></mesh>
    <RoundedBox args={[.025, .016, .22]} radius={.007} position={[0, .398, -.03]}><meshStandardMaterial color="#e0e0d9" metalness={1} roughness={.15} /></RoundedBox>
    {[0, 1, 2, 3, 4, 5].map(i => <mesh key={i} position={[(i - 2.5) * .028, .028, .197]}><boxGeometry args={[.008, .003, .09]} /><meshStandardMaterial color="#313630" /></mesh>)}
    <mesh position={[.087, .398, -.12]}><sphereGeometry args={[.009, 12, 8]} /><meshStandardMaterial color="#acd5b3" emissive="#91d49f" emissiveIntensity={1.4} /></mesh>
  </group>;
}

function DemoScene({ category, time, step, ghost, mode }: { category: Tutorial["category"]; time: number; step: number; ghost: boolean; mode: CameraMode }) {
  const hand = useRef<Group>(null);
  const target: Vec3 = category === "coffee" ? (step === 1 ? [-.14, 1.38, -.08] : step === 2 ? [-.14, 1.08, .24] : step === 4 ? [.38, 1.15, .15] : [-.14, 1.4, -.12]) : [.05, 1.09, .15];
  const phase = (Math.sin(time * .8) + 1) / 2;
  const wrist: Vec3 = [target[0] + .05 + .10 * (1 - phase), target[1] + .015 + .045 * (1 - phase), target[2] + .06 + .14 * (1 - phase)];
  return <group>
    {!ghost && <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[12, 12]} /><meshStandardMaterial color="#c5b99e" roughness={.95} /></mesh>
      <RoundedBox args={[2.8, .075, 1]} radius={.012} position={[0, .91, -.06]} castShadow receiveShadow><meshStandardMaterial color="#e0d5bd" roughness={.7} /></RoundedBox>
      <RoundedBox args={[2.7, .85, .85]} radius={.009} position={[0, .44, -.09]} receiveShadow castShadow><meshStandardMaterial color="#ac8e63" roughness={.8} /></RoundedBox>
      {[-.9, -.45, 0, .45, .9].map(x => <mesh key={x} position={[x, .45, .341]}><boxGeometry args={[.003, .75, .004]} /><meshStandardMaterial color="#6e6049" /></mesh>)}
      <mesh position={[0, 1.6, -.67]} receiveShadow><boxGeometry args={[5, 3.2, .08]} /><meshStandardMaterial color="#ece4d5" roughness={1} /></mesh>
      <RoundedBox args={[2.4, .035, .22]} position={[0, 1.82, -.52]} radius={.005} castShadow><meshStandardMaterial color="#ac8e63" /></RoundedBox>
      {[.7, .85, 1].map((x, i) => <mesh key={x} position={[x, 1.9 + i * .015, -.5]} castShadow><cylinderGeometry args={[.043, .037, .13 + i * .03, 24]} /><meshStandardMaterial color={["#c4b69c", "#e0d3b9", "#848d73"][i]} /></mesh>)}
      {category === "coffee" ? <><Machine /><Cup position={[-.14, 1.03, .22]} /><group position={[.36, 1.018, .11]}><mesh castShadow><cylinderGeometry args={[.047, .065, .14, 28]} /><meshPhysicalMaterial color="#f7f1dd" roughness={.12} transparent opacity={.72} /></mesh><mesh position={[.064, 0, 0]}><torusGeometry args={[.034, .006, 10, 22]} /><meshStandardMaterial color="#d2d5c8" /></mesh></group>{[0, 1, 2].map(i => <mesh key={i} position={[.48 + i * .055, .979, -.14]}><cylinderGeometry args={[.022, .018, .052, 24]} /><meshStandardMaterial color={["#ba8b42", "#98968c", "#664734"][i]} metalness={.8} roughness={.35} /></mesh>)}</> : category === "cooking" ? <><mesh position={[0, .97, .03]}><cylinderGeometry args={[.23, .15, .05, 40]} /><meshStandardMaterial color="#e2d7ba" /></mesh>{Array.from({length: 14}, (_, i) => <mesh key={i} position={[Math.sin(i * 4.3) * .14, 1.014, Math.cos(i * 2.4) * .14]} rotation={[1.3, i, .2]}><torusGeometry args={[.042, .009, 7, 14, 4.7]} /><meshStandardMaterial color="#dcab51" /></mesh>)}{[0, 1, 2, 3].map(i => <mesh key={i} position={[-.42 + i * .05, .984, -.16 + i * .025]}><sphereGeometry args={[.026, 20, 16]} /><meshStandardMaterial color="#be5534" /></mesh>)}</> : <group position={[0, 1.01, .02]}><RoundedBox args={[.6, .06, .45]} radius={.015}><meshStandardMaterial color="#ceb387" /></RoundedBox>{[-.23, .23].flatMap(x => [-.15, .15].map(z => <mesh key={`${x}${z}`} position={[x, .19, z]}><cylinderGeometry args={[.022, .032, .32, 20]} /><meshStandardMaterial color="#b79b72" /></mesh>))}</group>}
      <mesh position={[-.95, 1.04, -.3]} castShadow><cylinderGeometry args={[.1, .075, .17, 24]} /><meshStandardMaterial color="#cfb99b" roughness={1} /></mesh>
      {Array.from({ length: 9 }, (_, i) => <mesh key={i} position={[-.95 + Math.sin(i * 3) * .08, 1.22 + i * .017, -.3 + Math.cos(i * 2) * .08]} rotation={[.4, i, .5]}><sphereGeometry args={[.065, 12, 8]} /><meshStandardMaterial color={i % 2 ? "#778868" : "#5c7353"} /></mesh>)}
      {mode !== "first" && <group position={[.62, 0, 1.02]}><CapsuleBetween from={[0, .87, 0]} to={[0, 1.36, 0]} radius={.16} color="#657561" /><CapsuleBetween from={[-.085, .16, 0]} to={[-.085, .88, 0]} radius={.07} color="#d0c4ad" /><CapsuleBetween from={[.085, .16, 0]} to={[.085, .88, 0]} radius={.07} color="#d0c4ad" /><mesh position={[0, 1.56, 0]} scale={[.82, 1, .87]} castShadow><sphereGeometry args={[.105, 28, 24]} /><meshStandardMaterial color="#bf8b6b" roughness={.85} /></mesh><mesh position={[0, 1.62, .012]} scale={[.85, .5, .86]}><sphereGeometry args={[.111, 24, 16]} /><meshStandardMaterial color="#504134" /></mesh></group>}
    </>}
    <group ref={hand}><CapsuleBetween from={[.52, 1.34, 1.02]} to={[.36, 1.23, .67]} radius={.038} color={ghost ? "#99f6e4" : "#657561"} ghost={ghost} /><CapsuleBetween from={[.36, 1.23, .67]} to={wrist} radius={.023} color={ghost ? "#99f6e4" : "#bf8b6b"} ghost={ghost} /><Hand position={wrist} ghost={ghost} /></group>
    {!ghost && <ContactShadows position={[0, .001, 0]} opacity={.32} scale={8} blur={2.5} far={4} resolution={256} />}
  </group>;
}

export default function SceneViewer({ tutorial, time, mode, ghost = false, calibration, landmarkIndex, opacity = .6, objectAnchors, detailed, onReady, onError }: SceneViewerProps) {
  const scene = tutorial.scene;
  let end = 0;
  const sampleStep = tutorial.plan?.steps.findIndex(step => { end += step.durationSeconds; return time < end; }) ?? 0;
  const currentStep = scene?.steps.findIndex(s => time >= s.startTime && time < s.endTime) ?? (sampleStep < 0 ? (tutorial.plan?.steps.length ?? 1) - 1 : sampleStep);
  const hasAsset = scene?.assets.some(a => (a.kind === "scene" || a.kind === "sanitized_scene") && a.url);
  if (!hasAsset && !tutorial.isExample) return <div className="scene-unavailable"><span>Your scene is being prepared</span><p>The player will become available when your reconstruction passes its quality checks.</p></div>;
  return <SceneBoundary onError={onError}><Canvas shadows dpr={[1, 2]} camera={{ position: [2.4, 2.15, 2.8], fov: 42, near: .01, far: 100 }} gl={{ antialias: true, alpha: ghost }} style={{ background: ghost ? "transparent" : "#dfd8c9" }}>
    {!ghost && <color attach="background" args={["#dfd8c9"]} />}
    {!ghost && <StudioLight />}
    {ghost && <ambientLight intensity={1.2} />}
    <Suspense fallback={<Html center><span className="scene-loading">Preparing your scene…</span></Html>}>
      {hasAsset && scene ? <RecordedScene manifest={scene} time={time} ghost={ghost} opacity={opacity} objectAnchors={objectAnchors} detailed={detailed} onReady={onReady} /> : <DemoScene category={tutorial.category} time={time} step={Math.max(0, currentStep)} ghost={ghost} mode={mode} />}
      {!ghost && landmarkIndex !== undefined && scene?.landmarks[landmarkIndex] && <mesh position={scene.landmarks[landmarkIndex].position}><sphereGeometry args={[.022, 20, 16]} /><meshBasicMaterial color="#14b8a6" depthTest={false} /></mesh>}
    </Suspense>
    <CameraRig mode={mode} manifest={scene} calibration={calibration} />
  </Canvas></SceneBoundary>;
}
