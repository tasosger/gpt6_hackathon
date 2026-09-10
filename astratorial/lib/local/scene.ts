import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { z } from "zod";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { SceneManifestSchema, type SceneManifest, type TutorialPlan, type Vec3 } from "../contracts";

export const FINISHES = ["matte", "satin", "gloss", "ceramic", "metal", "brushed", "glass", "rubber", "wood", "light"] as const;
const FinishSchema = z.enum(FINISHES);
type Finish = z.infer<typeof FinishSchema>;
const vector = z.object({ x: z.number().min(-4).max(4), y: z.number().min(-2).max(4), z: z.number().min(-4).max(4) });
export const IllustrationSchema = z.object({
  surface: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), width: z.number().min(.5).max(3), depth: z.number().min(.4).max(2) }),
  objects: z.array(z.object({
    id: z.string(), position: vector, movable: z.boolean(),
    parts: z.array(z.object({ shape: z.enum(["box", "cylinder", "sphere", "torus"]), position: vector, size: z.object({ x: z.number().min(.002).max(2), y: z.number().min(.002).max(2), z: z.number().min(.002).max(2) }), rotation: vector, color: z.string().regex(/^#[0-9a-fA-F]{6}$/), metallic: z.boolean(), finish: FinishSchema.nullable() })).min(1).max(96),
  })).min(1).max(18),
  gestures: z.array(z.object({ stepId: z.string(), objectId: z.string(), hand: z.enum(["left", "right"]), contact: vector, endPosition: vector.nullable(), endRotation: vector.nullable() })).min(1).max(30),
  uncertainty: z.array(z.string()).max(12),
});
export type Illustration = z.infer<typeof IllustrationSchema>;
const xyz = (v: { x:number; y:number; z:number }):Vec3 => [v.x,v.y,v.z];
const vec = (v:Vec3) => new THREE.Vector3(...v);
const lerp = (a:Vec3,b:Vec3,t:number):Vec3 => a.map((n,i)=>n+(b[i]-n)*t) as Vec3;
const smooth=(v:number)=>v*v*(3-2*v);
const safeName=(value:string)=>value.replace(/[^A-Za-z0-9_-]/g,"_").slice(0,100);

/** A deliberately small, data-only scene language. AI output is never executed. */
export function validateIllustration(plan:TutorialPlan, input:unknown):Illustration {
  // Older saved illustrations predate material finishes; derive them from the metallic flag.
  const normalized=input&&typeof input==="object"&&Array.isArray((input as {objects?:unknown}).objects)?{...input,objects:(input as {objects:unknown[]}).objects.map(o=>o&&typeof o==="object"&&Array.isArray((o as {parts?:unknown}).parts)?{...o,parts:(o as {parts:unknown[]}).parts.map(part=>part&&typeof part==="object"&&!("finish" in part)?{...part,finish:null}:part)}:o)}:input;
  const scene=IllustrationSchema.parse(normalized);
  const ids=new Set(plan.objects.map(o=>o.id));
  if(scene.objects.some(o=>!ids.has(o.id))||new Set(scene.objects.map(o=>o.id)).size!==scene.objects.length)throw new Error("The illustration contains an unknown or duplicate object.");
  const objectIds=new Set(scene.objects.map(o=>o.id));
  if(plan.steps.some(step=>step.objectIds.some(id=>!objectIds.has(id))))throw new Error("The illustration must include every object referenced by a step, including the target of each interaction.");
  if(plan.steps.some(step=>!scene.gestures.some(g=>g.stepId===step.id)))throw new Error("Every step requires a gesture.");
  if(new Set(scene.gestures.map(g=>g.stepId)).size!==scene.gestures.length)throw new Error("Duplicate gesture step.");
  for(const gesture of scene.gestures) {
    const step=plan.steps.find(s=>s.id===gesture.stepId);
    if(!step||!objectIds.has(gesture.objectId)||!step.objectIds.includes(gesture.objectId))throw new Error("The gesture does not match its tutorial step.");
    if(gesture.endPosition&&!scene.objects.find(o=>o.id===gesture.objectId)?.movable)throw new Error("Fixed equipment cannot move.");
  }
  return scene;
}
/** Physically based finishes; every value exports to glTF so the player and poster renderer match. */
function material(color:string,metallic=false,finish:Finish|null=null) {
  const kind:Finish=finish??(metallic?"metal":"satin");
  const m=new THREE.MeshPhysicalMaterial({color,metalness:0,roughness:.5});
  switch(kind) {
    case "matte": m.roughness=.88;break;
    case "satin": m.roughness=.5;m.clearcoat=.08;m.clearcoatRoughness=.5;break;
    case "gloss": m.roughness=.22;m.clearcoat=1;m.clearcoatRoughness=.08;break;
    case "ceramic": m.roughness=.3;m.clearcoat=.7;m.clearcoatRoughness=.18;break;
    case "metal": m.metalness=1;m.roughness=.2;break;
    case "brushed": m.metalness=1;m.roughness=.44;break;
    case "glass": m.roughness=.04;m.transmission=1;m.ior=1.5;m.thickness=.015;m.color=new THREE.Color(color).lerp(new THREE.Color("#ffffff"),.5);break;
    case "rubber": m.roughness=.92;m.sheen=.35;m.sheenRoughness=.8;m.sheenColor=new THREE.Color(color);break;
    case "wood": m.roughness=.58;m.clearcoat=.18;m.clearcoatRoughness=.4;break;
    case "light": m.roughness=.4;m.emissive=new THREE.Color(color);m.emissiveIntensity=2.2;break;
  }
  return m;
}
function skin(color:string) { return new THREE.MeshPhysicalMaterial({color,roughness:.6,sheen:.2,sheenRoughness:.7,sheenColor:new THREE.Color("#ffd9c4")}); }
function cloth(color:string) { return new THREE.MeshPhysicalMaterial({color,roughness:.85,sheen:.5,sheenRoughness:.75,sheenColor:new THREE.Color(color).lerp(new THREE.Color("#ffffff"),.5)}); }
/** A cylinder with filleted rims instead of razor edges. */
function filletedCylinder(diameter:number,height:number) {
  const r=diameter/2,f=Math.min(.004,r*.18,height*.18);
  const points:THREE.Vector2[]=[new THREE.Vector2(0,-height/2)];
  const arc=(cx:number,cy:number,from:number,to:number)=>{for(let i=0;i<=5;i++){const a=from+(to-from)*i/5;points.push(new THREE.Vector2(cx+Math.cos(a)*f,cy+Math.sin(a)*f));}};
  arc(r-f,-height/2+f,-Math.PI/2,0);arc(r-f,height/2-f,0,Math.PI/2);
  points.push(new THREE.Vector2(0,height/2));
  return new THREE.LatheGeometry(points,64);
}
function mesh(geometry:THREE.BufferGeometry,color:string|THREE.Material,name:string,position:Vec3) {const result=new THREE.Mesh(geometry,typeof color==="string"?material(color):color);result.name=name;result.position.set(...position);result.castShadow=true;result.receiveShadow=true;return result;}
function link(name:string,start:Vec3,end:Vec3,radius:number,color:string|THREE.Material) { const object=mesh(new THREE.CylinderGeometry(radius,radius,1,24),color,name,lerp(start,end,.5));const direction=vec(end).sub(vec(start));object.scale.y=direction.length();object.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize());return object; }

/** Produces a portable animation with a common timebase for all views and ghost hands. */
export function buildIllustratedScene(plan:TutorialPlan, input:unknown, durations:Record<string,number>={}) {
  const illustration=validateIllustration(plan,input);
  const scene=new THREE.Scene();scene.name="AstratorialIllustratedWorkspace";
  const {width,depth}=illustration.surface;
  const surface=mesh(new RoundedBoxGeometry(width,.05,depth,4,.006),material(illustration.surface.color,false,"ceramic"),"WorkSurface",[0,-.025,0]);scene.add(surface);
  // A plain, texture-free room so light and shadow have somewhere to land: cabinet, floor, wall.
  const room=new THREE.Group();room.name="Room";
  const cabinet=`#${new THREE.Color(illustration.surface.color).lerp(new THREE.Color("#5e5a52"),.55).getHexString()}`;
  room.add(mesh(new RoundedBoxGeometry(width-.02,.86,depth-.03,3,.004),material(cabinet,false,"satin"),"Cabinet",[0,-.48,-.01]));
  room.add(mesh(new THREE.BoxGeometry(width-.1,.09,depth-.14),material("#2f2c28",false,"matte"),"ToeKick",[0,-.955,-.03]));
  for(const x of [-width/4,width/4]) {
    room.add(mesh(new THREE.BoxGeometry(width/2-.03,.72,.004),material(`#${new THREE.Color(cabinet).lerp(new THREE.Color("#ffffff"),.06).getHexString()}`,false,"satin"),`CabinetDoor${x<0?"L":"R"}`,[x,-.5,depth/2-.015]));
    const pull=mesh(filletedCylinder(.012,.11),material("#b9b6ad",true,"brushed"),`CabinetPull${x<0?"L":"R"}`,[x*1.6,-.2,depth/2-.006]);pull.rotation.x=Math.PI/2;room.add(pull);
  }
  const floor=mesh(new THREE.BoxGeometry(9,.02,9),material("#8d7c67",false,"wood"),"Floor",[0,-1.01,0]);floor.castShadow=false;room.add(floor);
  const wall=mesh(new THREE.BoxGeometry(9,3,.05),material("#e7e1d6",false,"matte"),"BackWall",[0,.5,-1.62]);wall.castShadow=false;room.add(wall);
  room.add(mesh(new THREE.BoxGeometry(9,.11,.012),material("#f2ede4",false,"satin"),"Baseboard",[0,-.945,-1.59]));
  scene.add(room);
  // Objects face the instructor (-Z), so the third-person camera looks from the instructor's side to keep controls visible.
  const bounds={min:[-2,-1,-1.45] as Vec3,max:[2,2,2] as Vec3};
  const objects:SceneManifest["objects"]=[];
  const groups=new Map<string,THREE.Group>();
  for(const item of illustration.objects) {
    const group=new THREE.Group();group.name=`Object_${safeName(item.id)}`;group.position.set(...xyz(item.position));
    item.parts.forEach((part,index)=>{
      let geometry:THREE.BufferGeometry;
      if(part.shape==="box")geometry=new RoundedBoxGeometry(part.size.x,part.size.y,part.size.z,4,Math.min(.006,Math.min(part.size.x,part.size.y,part.size.z)*.14));
      else if(part.shape==="cylinder")geometry=filletedCylinder(part.size.x,part.size.y);
      else if(part.shape==="sphere")geometry=new THREE.SphereGeometry(.5,48,32);
      else geometry=new THREE.TorusGeometry((part.size.x-Math.min(part.size.y,part.size.x/3))/2,Math.min(part.size.y,part.size.x/3)/2,24,96).rotateX(Math.PI/2);
      const component=new THREE.Mesh(geometry,material(part.color,part.metallic,part.finish));component.name=`${group.name}_Part${index}`;component.position.set(...xyz(part.position));component.rotation.set(...xyz(part.rotation));component.castShadow=true;component.receiveShadow=true;
      if(part.shape==="sphere")component.scale.set(part.size.x,part.size.y,part.size.z);
      group.add(component);
    });
    scene.add(group);groups.set(item.id,group);
    objects.push({id:item.id,nodeName:group.name,position:xyz(item.position),movable:item.movable,anchors:[{id:"base",position:xyz(item.position)}]});
  }
  // Generic, visibly illustrated instructor. Original capture likeness is never used.
  const body=new THREE.Group();body.name="TutorBody";
  const shirt=cloth("#536c5b"),trousers=cloth("#263c35"),flesh=skin("#c99070");
  body.add(mesh(new THREE.CapsuleGeometry(.18,.35,8,32),shirt,"TutorTorso",[0,.42,-.68]));
  body.add(mesh(new THREE.SphereGeometry(.135,48,32),flesh,"TutorHead",[0,.88,-.68]));
  for(const side of [-1,1])body.add(mesh(new THREE.SphereGeometry(.010,16,12),material("#3b322d",false,"gloss"),`TutorEye${side}`,[side*.044,.902,-.557]));
  body.add(mesh(new THREE.SphereGeometry(.018,16,12),flesh,"TutorNose",[0,.865,-.543]));
  body.add(mesh(new THREE.CapsuleGeometry(.14,.12,6,24),trousers,"TutorHips",[0,.05,-.68]));
  for(const side of [-1,1]) {
    body.add(link(`TutorLeg${side}`,[side*.1,-.08,-.68],[side*.13,-.87,-.65],.075,trousers));
    body.add(mesh(new RoundedBoxGeometry(.15,.09,.28,3,.02),material("#30332e",false,"rubber"),`TutorShoe${side}`,[side*.13,-.96,-.56]));
  }
  scene.add(body);
  const shoulders:{left:Vec3;right:Vec3}={left:[-.25,.58,-.65],right:[.25,.58,-.65]};
  const rests:{left:Vec3;right:Vec3}={left:[-.32,.2,-.3],right:[.32,.2,-.3]};
  const handNames={left:"TutorHand_L",right:"TutorHand_R"};
  const arms:{left:THREE.Mesh[];right:THREE.Mesh[]}={left:[],right:[]};
  for(const side of ["left","right"] as const) {
    const hand=new THREE.Group();hand.name=handNames[side];hand.position.set(...rests[side]);
    hand.add(mesh(new RoundedBoxGeometry(.065,.024,.085,3,.008),flesh,`${hand.name}_Palm`,[0,0,0]));
    for(let i=0;i<4;i++)hand.add(mesh(new THREE.CapsuleGeometry(.0075,.035,4,12),flesh,`${hand.name}_Finger${i}`,[-.025+i*.016,0,.061]));
    hand.children.slice(1).forEach(f=>f.rotation.x=Math.PI/2);
    const thumb=mesh(new THREE.CapsuleGeometry(.009,.024,4,12),flesh,`${hand.name}_Thumb`,[side==="left"?.045:-.045,0,.015]);thumb.rotation.z=Math.PI/3;hand.add(thumb);scene.add(hand);
    const elbow:Vec3=[shoulders[side][0]*1.35,.34,-.48];
    arms[side]=[link(`${side}_UpperArm`,shoulders[side],elbow,.045,shirt),link(`${side}_Forearm`,elbow,rests[side],.036,flesh)];
    arms[side].forEach(arm=>scene.add(arm));
  }
  let total=0;
  const steps=plan.steps.map(step=>{const startTime=total;total+=Math.max(4,durations[step.id]||step.durationSeconds);const gesture=illustration.gestures.find(g=>g.stepId===step.id)!;return {stepId:step.id,startTime,endTime:total,clipName:"Tutorial",handTargets:[{nodeName:handNames[gesture.hand],objectId:gesture.objectId}]};});
  const times:number[]=[];const handPositions={left:[] as number[],right:[] as number[]};
  const fingerRotations={left:Array.from({length:4},()=>[] as number[]),right:Array.from({length:4},()=>[] as number[])};
  const objectPositions=new Map(illustration.objects.map(o=>[o.id,[] as number[]]));
  const objectRotations=new Map(illustration.objects.map(o=>[o.id,[] as number[]]));
  const armTracks=new Map([...arms.left,...arms.right].map(arm=>[arm.name,{position:[] as number[],quaternion:[] as number[],scale:[] as number[]}]));
  const objectState=new Map(illustration.objects.map(o=>[o.id,{position:xyz(o.position),rotation:[0,0,0] as Vec3}]));
  for(let index=0;index<steps.length;index++) {
    const step=steps[index],planStep=plan.steps[index],gesture=illustration.gestures.find(g=>g.stepId===step.stepId)!;
    const initial=objectState.get(gesture.objectId)!;
    const target:Vec3=xyz(gesture.contact);
    const end=gesture.endPosition?xyz(gesture.endPosition):initial.position;
    const endRotation=gesture.endRotation?xyz(gesture.endRotation):initial.rotation;
    const count=Math.max(20,Math.ceil((step.endTime-step.startTime)*12));
    for(let n=0;n<=count;n++) {
      if(index&&n===0)continue;
      const u=n/count;times.push(step.startTime+u*(step.endTime-step.startTime));
      const active=smooth(Math.max(0,Math.min(1,(u-.35)/.4)));
      const moving=["move","pour","insert","rotate","open","close","grasp"].includes(planStep.action);
      for(const item of illustration.objects) {
        const state=objectState.get(item.id)!;
        const position=item.id===gesture.objectId&&moving?lerp(initial.position,end,active):state.position;
        const rotation=item.id===gesture.objectId&&moving?lerp(initial.rotation,endRotation,active):state.rotation;
        objectPositions.get(item.id)!.push(...position);objectRotations.get(item.id)!.push(...new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)).toArray());
      }
      for(const side of ["left","right"] as const) {
        let wrist:Vec3=rests[side];
        if(side===gesture.hand&&planStep.action!=="wait") {
          const contact=target.map((value,i)=>value+(moving?(end[i]-initial.position[i])*active:0)) as Vec3;
          if(planStep.action==="press")contact[1]-=.018*Math.sin(active*Math.PI);
          wrist=u<.3?lerp(rests[side],contact,smooth(u/.3)):u>.82?lerp(contact,rests[side],smooth((u-.82)/.18)):contact;
          if(u<.3)wrist[1]+=.1*Math.sin(u/.3*Math.PI);
        }
        handPositions[side].push(...wrist);
        const curl=side===gesture.hand&&planStep.action!=="wait"?smooth(Math.max(0,Math.min(1,(u-.25)/.13)))*smooth(Math.max(0,Math.min(1,(.88-u)/.13))):0;
        for(let finger=0;finger<4;finger++){
          const pointing=["press","point","reach"].includes(planStep.action);
          const bend=pointing&&finger===0?0:curl*(pointing?1.05:.75);
          fingerRotations[side][finger].push(...new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI/2+bend,0,0)).toArray());
        }
        const elbow=lerp(shoulders[side],wrist,.52);elbow[0]+=(side==="left"?-1:1)*.1;elbow[1]-=.07;
        const points=[shoulders[side],elbow,wrist];
        arms[side].forEach((arm,i)=>{const start=points[i],finish=points[i+1],direction=vec(finish).sub(vec(start));const track=armTracks.get(arm.name)!;track.position.push(...lerp(start,finish,.5));track.scale.push(1,direction.length(),1);track.quaternion.push(...new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize()).toArray());});
      }
    }
    if(["move","pour","insert","rotate","open","close","grasp"].includes(planStep.action))objectState.set(gesture.objectId,{position:end,rotation:endRotation});
  }
  const tracks:THREE.KeyframeTrack[]=[];
  for(const side of ["left","right"] as const){tracks.push(new THREE.VectorKeyframeTrack(`${handNames[side]}.position`,times,handPositions[side]));for(let finger=0;finger<4;finger++)tracks.push(new THREE.QuaternionKeyframeTrack(`${handNames[side]}_Finger${finger}.quaternion`,times,fingerRotations[side][finger]));}
  for(const [name,values]of armTracks){tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`,times,values.position),new THREE.VectorKeyframeTrack(`${name}.scale`,times,values.scale),new THREE.QuaternionKeyframeTrack(`${name}.quaternion`,times,values.quaternion));}
  for(const item of illustration.objects){const name=groups.get(item.id)!.name;tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`,times,objectPositions.get(item.id)!),new THREE.QuaternionKeyframeTrack(`${name}.quaternion`,times,objectRotations.get(item.id)!));}
  const clip=new THREE.AnimationClip("Tutorial",total,tracks);
  const manifest=SceneManifestSchema.parse({mode:"illustrated",version:1,units:"meters",assets:[],durationSeconds:total,cameras:{first:{position:[0,.8,-.5],target:[0,.15,.1]},third:{position:[1.85,1.25,-.4],target:[-.1,.15,0]}},bounds,landmarks:[],objects,steps,rig:{bodyNode:"TutorBody",handNodes:Object.values(handNames)},quality:{approved:true,registeredFrameRatio:0,medianReprojectionError:0,measurementErrors:[],notes:["AI-authored illustrated tutorial based on your video. Dimensions, geometry and gestures are approximate; this is not a measured reconstruction.",...illustration.uncertainty]},sanitized:false});
  return {scene,clip,manifest};
}
export async function exportGlb(scene:THREE.Scene,clip:THREE.AnimationClip):Promise<Buffer> {
  if(typeof globalThis.FileReader==="undefined") {
    class NodeFileReader {
      result:string|ArrayBuffer|null=null;onloadend:(()=>void)|null=null;
      readAsArrayBuffer(blob:Blob){void blob.arrayBuffer().then(value=>{this.result=value;this.onloadend?.();});}
      readAsDataURL(blob:Blob){void blob.arrayBuffer().then(value=>{this.result=`data:${blob.type};base64,${Buffer.from(value).toString("base64")}`;this.onloadend?.();});}
    }
    Object.defineProperty(globalThis,"FileReader",{value:NodeFileReader,writable:true,configurable:true});
  }
  const result=await new GLTFExporter().parseAsync(scene,{binary:true,animations:[clip],onlyVisible:true});
  if(!(result instanceof ArrayBuffer))throw new Error("Scene export did not produce a GLB.");
  if(result.byteLength>20_000_000)throw new Error("The illustrated scene exceeds the mobile asset allowance.");
  return Buffer.from(result);
}
