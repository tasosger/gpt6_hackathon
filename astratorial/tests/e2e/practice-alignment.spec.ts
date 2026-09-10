import { expect, test } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import path from "node:path";
import { getExample } from "../../lib/examples";
import type { PracticeSession, Tutorial, Vec3 } from "../../lib/contracts";

const landmarks: Vec3[] = [[-.6,.8,-.4],[.7,.8,-.3],[-.5,1.6,-.5],[.5,1.5,-.2],[-.3,1.1,.5],[.6,1.3,.6],[.1,1.6,.2],[-.5,.9,.3]];

test("fits a fixed camera, renders animated GLB ghost hands, and keeps completion explicit", async ({page}) => {
  const id="22222222-2222-4222-8222-222222222222";
  const example=getExample("example-espresso")!;
  const tutorial: Tutorial={...example,id,ownerId:"fixture-owner",isExample:false,visibility:"private",scene:{
    version:1,units:"meters",durationSeconds:10,
    assets:[{kind:"scene",path:"test/scene.glb",url:"/practice-fixture.glb"}],
    cameras:{first:{position:[0,1.6,1],target:[0,1.1,0]},third:{position:[2,2,3],target:[0,1,0]}},
    bounds:{min:[-3,0,-3],max:[3,3,4]},landmarks:landmarks.map((position,i)=>({id:String(i),label:`Landmark ${i+1}`,position})),objects:[],
    steps:[{stepId:example.plan!.steps[0].id,startTime:0,endTime:10,clipName:"tutorial"}],
    rig:{bodyNode:"TutorBody",handNodes:["TutorHand_L","TutorHand_R"]},
    quality:{approved:true,registeredFrameRatio:1,medianReprojectionError:.2,measurementErrors:[.01],notes:[]},sanitized:false,
  }};
  let session: PracticeSession={id:"practice-fixture",ownerId:"fixture-owner",tutorialId:id,tutorialRevision:1,currentStepIndex:0,version:0,status:"calibrating",completedStepIds:[],consecutiveComplete:0,calibration:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const errors:string[]=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("console",message=>{if(message.type()==="error"&&/shader|WebGLProgram/.test(message.text()))errors.push(message.text());});
  await page.addInitScript(()=>{
    Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
      const canvas=document.createElement("canvas");canvas.width=1280;canvas.height=720;
      const ctx=canvas.getContext("2d")!;const image=ctx.createImageData(1280,720);
      for(let y=0;y<720;y++)for(let x=0;x<1280;x++){const i=(y*1280+x)*4;const v=((Math.floor(x/4)*73856093^Math.floor(y/4)*19349663)>>>0)%256;image.data[i]=image.data[i+1]=image.data[i+2]=v;image.data[i+3]=255;}
      ctx.putImageData(image,0,0);const stream=canvas.captureStream(5);
      const timer=setInterval(()=>ctx.putImageData(image,0,0),200);stream.getVideoTracks()[0].addEventListener("ended",()=>clearInterval(timer));
      return stream;
    }});
  });
  await page.route("**/api/config",r=>r.fulfill({json:{configured:true,services:{database:true,openai:true,worker:true},user:{id:"fixture-owner",email:"test@example.com"}}}));
  await page.route(`**/api/tutorials/${id}`,r=>r.fulfill({json:{tutorial}}));
  await page.route("**/practice-fixture.glb",r=>r.fulfill({path:path.join(process.cwd(),"tests/fixtures/animated-scene.glb"),contentType:"model/gltf-binary"}));
  await page.route("**/api/practice",r=>r.fulfill({json:{session}}));
  await page.route("**/api/practice/practice-fixture",async r=>{
    if(r.request().method()==="PATCH"){
      const body=r.request().postDataJSON();
      session={...session,version:session.version+1,...(body.action==="calibrate"?{calibration:body.calibration,status:"active" as const}:{}),...(body.action==="pause"?{status:"paused" as const}:{}),...(body.action==="resume"||body.action==="repeat"?{status:"active" as const}:{})};
    }
    await r.fulfill({json:{session}});
  });
  await page.goto(`/tutorial/${id}/espresso/practice`);
  await page.getByRole("button",{name:"Open my camera"}).click();
  await expect(page.locator(".camera-status")).toContainText("ALIGN YOUR WORKSPACE");
  const camera=new PerspectiveCamera(52,1280/720,.01,100);camera.position.set(1.8,2.1,3.4);camera.lookAt(0,1.1,0);camera.updateMatrixWorld();
  const surface=page.locator(".camera-click-layer");
  for(const position of landmarks){const point=new Vector3(...position).project(camera);const box=(await surface.boundingBox())!;await surface.click({position:{x:(point.x+1)*box.width/2,y:(1-point.y)*box.height/2}});}
  await expect(page.locator(".camera-status")).toContainText("WORKSPACE ALIGNED");
  await page.getByRole("checkbox",{name:"Check progress automatically"}).uncheck();
  await expect(page.locator(".ghost-layer canvas")).toBeVisible();
  await page.getByRole("button",{name:"Pause guidance"}).click();
  await expect(page.getByRole("button",{name:"I’ve done this",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Resume guidance"}).click();
  await page.getByRole("button",{name:"Repeat this gesture"}).click();
  await expect(page.getByRole("button",{name:"I’ve done this",exact:true})).toBeEnabled();
  expect(session.currentStepIndex).toBe(0);
  await page.getByRole("button",{name:"Turn off camera"}).click();
  await expect(page.getByRole("button",{name:"Open my camera"})).toBeVisible();
  expect(errors).toEqual([]);
});
