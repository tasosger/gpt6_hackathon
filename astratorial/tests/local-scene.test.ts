import { describe,it,expect } from "vitest";
import { buildIllustratedScene, exportGlb, validateIllustration, type Illustration } from "../lib/local/scene";
import { validatePlanIds, truncateUtf8 } from "../lib/local/pipeline";
import { type TutorialPlan } from "../lib/contracts";
const plan:TutorialPlan={version:1,title:"Move a cup",goal:"Place the cup under the spout",description:"An illustrated test",category:"coffee",difficulty:"Beginner",estimatedMinutes:1,objects:[{id:"cup",name:"Cup",kind:"vessel",observed:true,notes:""}],steps:[{id:"place",title:"Place the cup",instruction:"Move the cup to the spout",narration:"Place your cup under the spout.",durationSeconds:5,objectIds:["cup"],observable:true,completionCriteria:"Cup is under the spout",sourceIds:[],action:"move"}],sources:[],questions:[],constraints:[]};
const illustration:Illustration={surface:{width:1,depth:.6,color:"#dfd8c8"},objects:[{id:"cup",position:{x:0,y:0,z:0},movable:true,parts:[{shape:"cylinder",position:{x:0,y:.05,z:0},size:{x:.09,y:.1,z:.09},rotation:{x:0,y:0,z:0},color:"#f2eee4",metallic:false,finish:"ceramic"}]}],gestures:[{stepId:"place",objectId:"cup",hand:"right",contact:{x:0,y:.08,z:0},endPosition:{x:.2,y:0,z:.1},endRotation:null}],uncertainty:["Approximate dimensions"]};
describe("Local illustrated scene",()=>{
  it("exports a real portable GLB with baked human-hand and object animation",async()=>{const built=buildIllustratedScene(plan,illustration);const bytes=await exportGlb(built.scene,built.clip);expect(bytes.subarray(0,4).toString()).toBe("glTF");expect(bytes.length).toBeLessThan(20_000_000);const jsonLength=bytes.readUInt32LE(12);const gltf=JSON.parse(bytes.subarray(20,20+jsonLength).toString());expect(gltf.animations).toHaveLength(1);expect(gltf.nodes.some((n:{name:string})=>n.name==="TutorHand_R")).toBe(true);expect(built.manifest.mode).toBe("illustrated");expect(built.manifest.landmarks).toEqual([]);expect(built.manifest.quality.registeredFrameRatio).toBe(0);const position=built.clip.tracks.find(t=>t.name==="Object_cup.position")!;expect(Array.from(position.values.slice(-3))).toEqual([expect.closeTo(.2,4),0,expect.closeTo(.1,4)]);});
  it("rejects unknown references, duplicated steps and attempts to move fixed equipment",()=>{expect(()=>validateIllustration(plan,{...illustration,gestures:[{...illustration.gestures[0],objectId:"unknown"}]})).toThrow();expect(()=>validateIllustration(plan,{...illustration,gestures:[...illustration.gestures,...illustration.gestures]})).toThrow();expect(()=>validateIllustration(plan,{...illustration,objects:[{...illustration.objects[0],movable:false}]})).toThrow();});
  it("requires the receiving pan as well as the sauce container for a pouring step",()=>{
    const pouringPlan:TutorialPlan={...plan,objects:[{...plan.objects[0],id:"sauce"},{...plan.objects[0],id:"pan"}],steps:[{...plan.steps[0],id:"pour",objectIds:["sauce","pan"],action:"pour"}]};
    const missingPan:Illustration={...illustration,objects:[{...illustration.objects[0],id:"sauce"}],gestures:[{...illustration.gestures[0],stepId:"pour",objectId:"sauce"}]};
    expect(()=>validateIllustration(pouringPlan,missingPan)).toThrow(/every object referenced/);
    expect(()=>validateIllustration(pouringPlan,{...missingPan,objects:[...missingPan.objects,{...illustration.objects[0],id:"pan",movable:false}]})).not.toThrow();
  });
  it("bounds geometry and preserves a matching step timebase",()=>{expect(()=>validateIllustration(plan,{...illustration,objects:[{...illustration.objects[0],position:{x:200,y:0,z:0}}]})).toThrow();const built=buildIllustratedScene(plan,illustration,{place:9});expect(built.clip.duration).toBe(9);expect(built.manifest.steps[0].endTime).toBe(9);expect(built.manifest.durationSeconds).toBe(9);});
  it("validates plan identity and limits UTF-8 narration inputs",()=>{expect(()=>validatePlanIds({...plan,steps:[{...plan.steps[0],objectIds:["absent"]}]})).toThrow();const result=truncateUtf8("☕".repeat(100),40);expect(Buffer.byteLength(result)).toBeLessThanOrEqual(40);expect(result).not.toContain("�");});
});
describe("Scene rendering fidelity",()=>{
  it("exports detailed objects above the old part limit and bounds excessive output",async()=>{
    const detailed=structuredClone(illustration);
    detailed.objects[0].parts=Array.from({length:96},(_,i)=>({...illustration.objects[0].parts[0],position:{x:(i%12)*.01,y:.05,z:Math.floor(i/12)*.01}}));
    const built=buildIllustratedScene(plan,validateIllustration(plan,detailed));
    expect(built.scene.getObjectByName("Object_cup")?.children).toHaveLength(96);
    const bytes=await exportGlb(built.scene,built.clip);
    expect(bytes.subarray(0,4).toString()).toBe("glTF");
    detailed.objects[0].parts.push(detailed.objects[0].parts[0]);
    expect(()=>validateIllustration(plan,detailed)).toThrow();
  });
  it("accepts saved illustrations without finishes and exports physical materials plus a room",async()=>{
    const legacy=JSON.parse(JSON.stringify(illustration));delete legacy.objects[0].parts[0].finish;
    const built=buildIllustratedScene(plan,legacy);
    const names=new Set<string>();built.scene.traverse(node=>names.add(node.name));
    for(const expected of ["Room","Cabinet","Floor","BackWall","WorkSurface","TutorBody"])expect(names.has(expected)).toBe(true);
    const bytes=await exportGlb(built.scene,built.clip);const jsonLength=bytes.readUInt32LE(12);const gltf=JSON.parse(bytes.subarray(20,20+jsonLength).toString());
    expect(gltf.extensionsUsed).toEqual(expect.arrayContaining(["KHR_materials_clearcoat"]));
    expect(built.manifest.bounds.min[2]).toBeGreaterThan(-1.62);
  });
  it("maps glass and emissive finishes to glTF extensions",async()=>{
    const glassy:Illustration={...illustration,objects:[{...illustration.objects[0],parts:[{...illustration.objects[0].parts[0],finish:"glass"},{...illustration.objects[0].parts[0],finish:"light",position:{x:0,y:.12,z:0}}]}]};
    const built=buildIllustratedScene(plan,glassy);const bytes=await exportGlb(built.scene,built.clip);const jsonLength=bytes.readUInt32LE(12);const gltf=JSON.parse(bytes.subarray(20,20+jsonLength).toString());
    expect(gltf.extensionsUsed).toEqual(expect.arrayContaining(["KHR_materials_transmission","KHR_materials_emissive_strength"]));
  });
});
