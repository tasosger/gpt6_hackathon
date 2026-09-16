import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/**
 * One studio setup for the interactive player and the poster renderer: an image-based room
 * environment for reflections, a soft window key with high-resolution shadows, a large area
 * fill for broad highlights on metal and ceramic, and AgX tone mapping (Blender's default view).
 */
export function installSceneLighting(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const previous = { environment: scene.environment, intensity: scene.environmentIntensity,
    toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
    shadows: renderer.shadowMap.enabled, shadowType: renderer.shadowMap.type };
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  RectAreaLightUniformsLib.init();
  const generator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = generator.fromScene(room, .04);
  room.dispose();
  generator.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = .38;

  const lights = new THREE.Group();
  lights.name = "WorkspaceLighting";
  lights.add(new THREE.HemisphereLight("#dfe8f7", "#5f5347", .14));
  // Window key: warm, from the instructor's front-left, tight frustum for crisp contact shadows.
  const key = new THREE.DirectionalLight("#fff0d8", 3.6);
  key.position.set(-2.2, 3.6, 1.6);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -2.2, right: 2.2, top: 2.6, bottom: -1.6, near: .5, far: 10 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -.00008;
  key.shadow.normalBias = .01;
  key.shadow.radius = 3;
  lights.add(key);
  // Large soft box from the viewer's side, like a bounce card, for broad specular on metal.
  const softbox = new THREE.RectAreaLight("#e9f0ff", 1.6, 2.4, 1.6);
  softbox.position.set(2.2, 1.9, .6);
  softbox.lookAt(0, .2, 0);
  lights.add(softbox);
  // Cool rim from behind the instructor separates them from the wall.
  const rim = new THREE.DirectionalLight("#cfe0ff", .9);
  rim.position.set(1.2, 2.4, -3);
  lights.add(rim);
  scene.add(lights);
  return () => {
    scene.remove(lights);
    key.shadow.dispose();
    environment.dispose();
    scene.environment = previous.environment;
    scene.environmentIntensity = previous.intensity;
    renderer.toneMapping = previous.toneMapping;
    renderer.toneMappingExposure = previous.exposure;
    renderer.shadowMap.enabled = previous.shadows;
    renderer.shadowMap.type = previous.shadowType;
  };
}

/** Frame pipeline shared by the player and poster renderer: MSAA, ambient occlusion, tone mapping. */
export function createScenePipeline(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number) {
  const pixelRatio = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(width * pixelRatio, height * pixelRatio, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);
  const ao = new GTAOPass(scene, camera, width, height);
  ao.output = GTAOPass.OUTPUT.Default;
  ao.blendIntensity = 1;
  ao.updateGtaoMaterial({ radius: .18, distanceExponent: 1.2, thickness: .6, scale: 1.4, samples: 20, distanceFallOff: 1, screenSpaceRadius: false });
  ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(ao);
  composer.addPass(new OutputPass());
  return {
    render: () => composer.render(),
    setSize: (w: number, h: number) => { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); ao.setSize(w, h); },
    setCamera: (next: THREE.Camera) => { ao.camera = next; for (const pass of composer.passes) if (pass instanceof RenderPass) pass.camera = next; },
    dispose: () => { composer.dispose(); ao.dispose(); target.dispose(); },
  };
}
