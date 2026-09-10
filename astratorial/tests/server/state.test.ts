import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { applyPracticeAction, applyStepCheck, canonicalCalibration } from "../../lib/server/practice";
import { publicSnapshot, validArtifactPath, publicSourceUrl } from "../../lib/server/tutorials";
import type { PracticeSession, SceneManifest, Tutorial, Vec3 } from "../../lib/contracts";

const world:Vec3[]=[[-.6,.8,-.4],[.7,.8,-.3],[-.5,1.6,-.5],[.5,1.5,-.2],[-.3,1.1,.5],[.6,1.3,.6],[.1,1.6,.2],[-.5,.9,.3]];
const step=(id:string,observable=true)=>({id,title:id,instruction:"Press the observed control",narration:"Press the control",durationSeconds:5,objectIds:[],observable,completionCriteria:"The light is visible",sourceIds:[],action:"press" as const});
const scene:SceneManifest={version:1,units:"meters",assets:[{path:"owner/tutorial/r1/public-preview/10000000-0000-4000-8000-000000000001/scene.glb",kind:"sanitized_scene"}],durationSeconds:10,cameras:{first:{position:[0,1,2],target:[0,1,0]},third:{position:[2,2,2],target:[0,1,0]}},bounds:{min:[-2,0,-2],max:[2,3,2]},landmarks:world.map((position,i)=>({id:String(i),label:`Point ${i}`,position})),objects:[],steps:[{stepId:"s1",startTime:0,endTime:5,clipName:"s1"},{stepId:"s2",startTime:5,endTime:10,clipName:"s2"}],rig:{bodyNode:"body",handNodes:["left","right"]},quality:{approved:true,registeredFrameRatio:1,medianReprojectionError:0,measurementErrors:[],notes:[]},sanitized:true};
const tutorial:Tutorial={id:"tutorial",ownerId:"owner",title:"Coffee",slug:"coffee",description:"Make coffee",category:"coffee",visibility:"private",status:"ready",revision:1,createdAt:"now",updatedAt:"now",goal:"Make coffee",constraints:["private note"],referenceUrls:["https://private.example/reference"],assets:[{id:"capture",path:"owner/tutorial/r1/private.mp4",name:"private.mp4",mimeType:"video/mp4",size:100,kind:"video",pass:"room"}],measurements:[],plan:{version:1,title:"Coffee",goal:"Make coffee",description:"Make coffee",category:"coffee",difficulty:"Beginner",estimatedMinutes:3,objects:[{id:"machine",name:"Machine",kind:"equipment",observed:true,notes:"private note"}],steps:[step("s1"),step("s2")],sources:[],questions:[{id:"q",question:"Private room question",reason:"coverage",required:false}],constraints:["private note"]},scene,job:null,thumbnailUrl:null,isExample:false};
const session:PracticeSession={id:"practice",ownerId:"owner",tutorialId:"tutorial",tutorialRevision:1,currentStepIndex:0,version:0,status:"active",completedStepIds:[],consecutiveComplete:0,calibration:{position:[1,1,1]},createdAt:"now",updatedAt:"now"};
function observations(){const camera=new PerspectiveCamera(52,1280/720,.01,100);camera.position.set(1.8,2.1,3.4);camera.lookAt(0,1.1,0);camera.updateMatrixWorld();return world.map((point,i)=>{const screen=new Vector3(...point).project(camera);return{id:String(i),image:[(screen.x+1)*640,(1-screen.y)*360],world:[999,999,999],check:false};});}

describe("server owned practice",()=>{
  it("discards checks for an older session version",()=>{expect(()=>applyStepCheck({...session,version:2},tutorial,{stepId:"s1",status:"complete",evidence:"light",guidance:""},1)).toThrow(/changed/);});
  it("requires consistent visible evidence before automatic advancement",()=>{const first=applyStepCheck(session,tutorial,{stepId:"s1",status:"complete",evidence:"light",guidance:""},0);expect(first.currentStepIndex).toBe(0);const uncertain=applyStepCheck(first,tutorial,{stepId:"s1",status:"uncertain",evidence:"occluded",guidance:""},1);expect(uncertain.consecutiveComplete).toBe(0);const second=applyStepCheck(first,tutorial,{stepId:"s1",status:"complete",evidence:"light",guidance:""},1);expect(second.currentStepIndex).toBe(1);expect(second.completedStepIds).toEqual(["s1"]);});
  it("never automatically completes a hidden state",()=>{const hidden={...tutorial,plan:{...tutorial.plan!,steps:[step("s1",false),step("s2")]}};const next=applyStepCheck({...session,consecutiveComplete:1},hidden,{stepId:"s1",status:"complete",evidence:"guess",guidance:""},0);expect(next.currentStepIndex).toBe(0);expect(next.consecutiveComplete).toBe(0);});
  it("requires calibration before manual progression and rejects revision changes",()=>{expect(()=>applyPracticeAction({...session,calibration:null,status:"calibrating"},tutorial,{action:"confirm",version:0})).toThrow(/Align/);expect(()=>applyPracticeAction(session,{...tutorial,revision:2},{action:"confirm",version:0})).toThrow(/changed/);});
  it("completes the final step without moving beyond the plan",()=>{const next=applyPracticeAction({...session,currentStepIndex:1,completedStepIds:["s1"]},tutorial,{action:"confirm",version:0});expect(next.status).toBe("completed");expect(next.currentStepIndex).toBe(1);expect(next.completedStepIds).toEqual(["s1","s2"]);});
  it("invalidates camera pose and resets accumulated evidence after movement",()=>{const next=applyPracticeAction({...session,consecutiveComplete:1},tutorial,{action:"invalidate",version:0});expect(next.calibration).toBeNull();expect(next.status).toBe("calibrating");expect(next.consecutiveComplete).toBe(0);});
  it("bounds object movement by verified hand associations and the same support surface",()=>{
    const moving={...tutorial,plan:{...tutorial.plan!,steps:[{...step("s1"),objectIds:["cup"]},step("s2")]},scene:{...scene,objects:[{id:"cup",nodeName:"cup",position:[0,1,0] as Vec3,movable:true,anchors:[]}],steps:scene.steps.map(item=>({...item,handTargets:[{nodeName:"left",objectId:"cup"}]}))}};
    const anchored=applyPracticeAction(session,moving,{action:"anchor",version:0,objectId:"cup",position:[.1,1,0]});
    expect(anchored.calibration?.objectAnchors).toEqual({cup:{position:[.1,1,0],stepId:"s1"}});
    expect(()=>applyPracticeAction(session,moving,{action:"anchor",version:0,objectId:"cup",position:[.16,1,0]})).toThrow(/15 cm/);
    expect(()=>applyPracticeAction(session,moving,{action:"anchor",version:0,objectId:"cup",position:[.05,1.03,0]})).toThrow(/same surface/);
    const unlinked={...moving,scene:{...moving.scene,steps:scene.steps}};
    expect(()=>applyPracticeAction(session,unlinked,{action:"anchor",version:0,objectId:"cup",position:[.03,1,0]})).toThrow(/2 cm/);
    const unconfirmed=applyStepCheck({...session,consecutiveComplete:1},moving,{stepId:"s1",status:"complete",evidence:"cup is visible",guidance:""},0);
    expect(unconfirmed.currentStepIndex).toBe(0);
  });
  it("recomputes calibration from trusted scene positions and held-out landmarks",()=>{const result=canonicalCalibration(tutorial,{points:observations(),width:1280,height:720,fitError:0,position:[999,999,999]});expect(result.position[0]).toBeCloseTo(1.8,2);expect(result.checkError).toBeLessThan(.1);expect(result.points[6].check).toBe(true);});
  it("does not accept forged calibration quality or reused landmarks",()=>{const points=observations();points[7].image[0]+=150;expect(()=>canonicalCalibration(tutorial,{points,width:1280,height:720,fitError:0,checkError:0})).toThrow(/check points/);points[7]=points[0];expect(()=>canonicalCalibration(tutorial,{points,width:1280,height:720})).toThrow(/different/);});
});
describe("public snapshots",()=>{
  it("removes captures, identity, measurement context and room questions",()=>{const published=publicSnapshot(tutorial,scene);expect(published.assets).toEqual([]);expect(published.ownerId).toBe("");expect(published.constraints).toEqual([]);expect(published.referenceUrls).toEqual([]);expect(published.plan?.questions).toEqual([]);expect(published.plan?.objects[0].notes).toBe("");expect(published.visibility).toBe("public");});
  it("excludes private/signed references and preserves valid manufacturer links",()=>{
    expect(publicSourceUrl("https://project.supabase.co/storage/v1/object/sign/captures/private.mp4?token=secret")).toBeNull();
    expect(publicSourceUrl("https://storage.example/manual.pdf?X-Amz-Signature=secret")).toBeNull();
    expect(publicSourceUrl("https://user:password@example.com/manual")).toBeNull();
    expect(publicSourceUrl("http://192.168.1.2/manual")).toBeNull();
    expect(publicSourceUrl("https://manufacturer.example/manual?id=123&utm_source=personal#page2")).toBe("https://manufacturer.example/manual?id=123");
    const sourcePlan={...tutorial.plan!,sources:[{id:"private",title:"Capture",url:"https://project.supabase.co/storage/v1/object/sign/captures/file",note:""}],steps:[{...step("s1"),sourceIds:["private"]}]};
    const published=publicSnapshot({...tutorial,plan:sourcePlan,adaptationPlan:sourcePlan},scene);
    expect(published.plan?.sources).toEqual([]);expect(published.plan?.steps[0].sourceIds).toEqual([]);expect(published.adaptationPlan?.sources).toEqual([]);
  });
  it("allows only synthesized narration from the trusted public export directory",()=>{
    const narration={kind:"sanitized_narration",path:"owner/tutorial/r1/public-preview/10000000-0000-4000-8000-000000000001/s1.wav",stepId:"s1"};
    const published=publicSnapshot(tutorial,{...scene,assets:[...scene.assets,narration]});
    expect(published.scene?.assets.some(asset=>asset.kind==="sanitized_narration")).toBe(true);
    expect(()=>publicSnapshot(tutorial,{...scene,assets:[...scene.assets,{...narration,path:"owner/tutorial/r1/delivery/10000000-0000-4000-8000-000000000001/s1.wav"}]})).toThrow(/cropped/);
    expect(()=>publicSnapshot(tutorial,{...scene,assets:[...scene.assets,{...narration,path:"another/tutorial/r1/public-preview/10000000-0000-4000-8000-000000000001/s1.wav"}]})).toThrow(/cropped/);
  });
  it("rejects original assets even when a manifest claims to be sanitized",()=>{expect(()=>publicSnapshot(tutorial,{...scene,assets:[...scene.assets,{kind:"scene",path:"owner/tutorial/r1/private.glb"}]})).toThrow(/cropped/);expect(()=>publicSnapshot(tutorial,{...scene,sanitized:false})).toThrow(/cropped/);});
  it("rejects cross-tutorial paths and traversal",()=>{expect(validArtifactPath("owner/another/r1/file.glb","tutorial")).toBe(false);expect(validArtifactPath("owner/tutorial/../file.glb","tutorial")).toBe(false);expect(()=>publicSnapshot(tutorial,{...scene,assets:[{kind:"sanitized_scene",path:"owner/other/r1/file.glb"}]})).toThrow(/cropped/);});
});
