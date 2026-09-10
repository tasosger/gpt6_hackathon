import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import type { SceneManifest } from "../contracts";
import { LocalFailure, rendererFailure } from "./failures";

/** Trusted renderer: only the exported GLB is loaded; no generated code executes. */
export async function renderIllustration(glbPath:string,manifest:SceneManifest,directory:string,recordVideo:boolean) {
  try { return await renderLocalScene(glbPath,manifest,directory,recordVideo); }
  catch(error) { throw rendererFailure(error); }
}

async function renderLocalScene(glbPath:string,manifest:SceneManifest,directory:string,recordVideo:boolean) {
  const browserScript=await build({stdin:{contents:`
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(960,720);renderer.setPixelRatio(1);renderer.setClearColor(0xeeeae1);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.3;
    document.body.appendChild(renderer.domElement);
    const scene=new THREE.Scene();scene.add(new THREE.HemisphereLight(0xffffff,0xa7a694,3));
    for(const [position,intensity]of [[[2,4,3],3],[[-2,2,-1],2]]){const light=new THREE.DirectionalLight(0xffffff,intensity);light.position.set(...position);scene.add(light);}
    const camera=new THREE.PerspectiveCamera(43,960/720,.01,50);camera.position.set(...${JSON.stringify(manifest.cameras.third.position)});camera.lookAt(...${JSON.stringify(manifest.cameras.third.target)});
    const asset=await new GLTFLoader().loadAsync('./scene.glb');scene.add(asset.scene);
    const mixer=new THREE.AnimationMixer(asset.scene);for(const clip of asset.animations)mixer.clipAction(clip).play();
    const draw=time=>{mixer.setTime(time);renderer.render(scene,camera);};draw(1);
    window.recordTutorial=async function(duration){
      const mimeType=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mimeType)throw new Error('This browser cannot record the scene.');
      const stream=renderer.domElement.captureStream(24);const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:1300000});const chunks=[];
      const result=new Promise(resolve=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=async()=>{const bytes=new Uint8Array(await new Blob(chunks,{type:mimeType}).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));resolve(btoa(binary));};});
      draw(0);recorder.start(1000);const start=performance.now();
      await new Promise(resolve=>{const frame=()=>{const time=Math.min(duration,(performance.now()-start)/1000);draw(time);if(time<duration)requestAnimationFrame(frame);else resolve();};requestAnimationFrame(frame);});
      recorder.stop();stream.getTracks().forEach(track=>track.stop());return result;
    };
    window.sceneReady=true;
  `,resolveDir:process.cwd(),loader:"js"},bundle:true,format:"esm",platform:"browser",write:false,minify:true,logLevel:"silent"});
  const token=randomUUID();const script=browserScript.outputFiles[0].contents;const glb=await readFile(glbPath);
  const server=createServer((request,response)=>{
    const path=request.url||"";
    if(path===`/${token}/`){response.setHeader("Content-Type","text/html");response.end('<!doctype html><html><body style="margin:0;overflow:hidden"><script type="module" src="./render.js"></script></body></html>');}
    else if(path===`/${token}/render.js`){response.setHeader("Content-Type","text/javascript");response.end(script);}
    else if(path===`/${token}/scene.glb`){response.setHeader("Content-Type","model/gltf-binary");response.end(glb);}
    else{response.statusCode=404;response.end();}
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();if(!address||typeof address==="string")throw new Error("Local renderer could not start.");
  const origin=`http://127.0.0.1:${address.port}`;
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:["--disable-background-timer-throttling","--disable-renderer-backgrounding"]}).catch(error=>{server.close();throw error;});
  try {
    const page=await browser.newPage({viewport:{width:960,height:720}});
    // Surface WebGL/GLB load failures immediately instead of hiding their cause
    // behind a 30-second readiness timeout. Only an allowlisted message escapes.
    const failed=new Promise<never>((_resolve,reject)=>{
      page.once("pageerror",error=>reject(rendererFailure(error)));
      page.once("crash",()=>reject(new LocalFailure("renderer_crashed","The 3D preview browser ran out of resources. Close other busy apps and retry. Your animation and narration are saved.")));
    });
    await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await Promise.race([failed,(async()=>{await page.goto(`${origin}/${token}/`);await page.waitForFunction("window.sceneReady === true",{},{timeout:30_000});})()]);
    const poster=join(directory,"poster.jpg");await page.screenshot({path:poster,type:"jpeg",quality:85});
    let video:string|undefined;
    if(recordVideo) {
      if(manifest.durationSeconds>600)throw new LocalFailure("video_too_long","This tutorial is longer than the ten-minute video export limit. Create a shorter tutorial to download it as a video.");
      const encoded=await Promise.race([failed,page.evaluate(async(duration)=>await (window as unknown as {recordTutorial:(d:number)=>Promise<string>}).recordTutorial(duration),manifest.durationSeconds)]);
      video=join(directory,"recorded.webm");await writeFile(video,Buffer.from(encoded,"base64"));
    }
    return {poster,video};
  } finally {await browser.close().catch(()=>undefined);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
