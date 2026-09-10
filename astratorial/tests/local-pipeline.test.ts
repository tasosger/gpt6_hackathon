import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runLocalClaim } from "../lib/local/pipeline";
import type { GenerationJob, Tutorial, TutorialPlan } from "../lib/contracts";
import type { Illustration } from "../lib/local/scene";

const ai=vi.hoisted(()=>({parse:vi.fn(),speech:vi.fn()}));
vi.mock("openai",async(importOriginal)=>{
  const original=await importOriginal<typeof import("openai")>();
  class MockOpenAI {
    static APIError=original.default.APIError;
    responses={parse:ai.parse};
    audio={speech:{create:ai.speech}};
  }
  return {...original,default:MockOpenAI};
});
vi.mock("node:child_process",()=>({execFile:(_program:unknown,_args:unknown,_options:unknown,callback:(error:null,result:{stdout:string;stderr:string})=>void)=>callback(null,{stdout:"5",stderr:""})}));
vi.mock("../lib/local/render",()=>({renderIllustration:async(_glb:unknown,_manifest:unknown,directory:string)=>{
  const poster=join(directory,"poster.jpg");await writeFile(poster,"preview");return {poster};
}}));

const plan:TutorialPlan={version:1,title:"Make pasta",goal:"Make pasta with the sauce in my fridge",description:"Use the supplies from your video",category:"cooking",difficulty:"Beginner",estimatedMinutes:10,objects:[{id:"pan",name:"Pan",kind:"vessel",observed:true,notes:""}],steps:[{id:"fill",title:"Fill the pan",instruction:"Fill the pan with water",narration:"Fill your pan with water from the faucet.",durationSeconds:5,objectIds:["pan"],observable:true,completionCriteria:"The pan contains water",sourceIds:[],action:"move"}],sources:[],questions:[{id:"salt",question:"Do you have salt?",reason:"Optional seasoning",required:true}],constraints:[]};
const illustration:Illustration={surface:{width:1,depth:.6,color:"#dfd8c8"},objects:[{id:"pan",position:{x:0,y:0,z:0},movable:true,parts:[{shape:"cylinder",position:{x:0,y:.05,z:0},size:{x:.2,y:.1,z:.2},rotation:{x:0,y:0,z:0},color:"#999999",metallic:true}]}],gestures:[{stepId:"fill",objectId:"pan",hand:"right",contact:{x:0,y:.08,z:0},endPosition:{x:.2,y:0,z:.1},endRotation:null}],uncertainty:["Approximate dimensions"]};
const tutorial:Tutorial={id:"tutorial",ownerId:"owner",title:"Untitled tutorial",slug:"untitled-tutorial",description:"",category:"home",visibility:"private",status:"generating",revision:1,createdAt:"now",updatedAt:"now",goal:"",constraints:[],referenceUrls:[],assets:[{id:"video",path:"owner/tutorial/r1/video.mp4",name:"Kitchen.mp4",mimeType:"video/mp4",size:100,kind:"video",pass:"room"}],measurements:[],plan:null,scene:null,job:null,thumbnailUrl:null,isExample:false};
const job:GenerationJob={id:"job",tutorialId:"tutorial",revision:1,kind:"generate",status:"running",stage:"ingest",progress:0,message:"",budgetUsd:25,spentUsd:0,reservedUsd:0,createdAt:"now",updatedAt:"now",error:null};
const ingest={frames:[{path:"owner/tutorial/r1/frame.jpg",label:"Kitchen at 1 second"}],transcript:"I want to make pasta. The sauce is in the fridge and the pasta is in the pantry.",manualText:""};
type Saved={p_stage:string;p_status:string;p_progress:number;p_checkpoint:Record<string,unknown>;p_tutorial_patch:Partial<Tutorial>;p_message:string};
function database(options:{denyBudget?:boolean;cancelAtPlan?:boolean}={}) {
  const saves:Saved[]=[];let active=true;
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
    if(name==="heartbeat_job")return {data:active,error:null};
    if(name==="reserve_job_cost")return {data:!options.denyBudget,error:null};
    if(name==="checkpoint_job"){
      saves.push(structuredClone(args) as Saved);
      if(args.p_status!=="running"||(options.cancelAtPlan&&args.p_stage==="plan"))active=false;
    }
    return {data:true,error:null};
  });
  const upload=vi.fn(async()=>({error:null}));
  const download=vi.fn(async()=>({data:new Blob(["frame"]),error:null}));
  const db={rpc,storage:{from:()=>({upload,download})}} as unknown as SupabaseClient;
  return {db,saves,rpc,upload};
}
beforeEach(()=>{
  vi.clearAllMocks();ai.parse.mockReset();ai.speech.mockReset();vi.stubEnv("OPENAI_API_KEY","test-key");
  ai.speech.mockResolvedValue(new Response("narration"));
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});

describe("single-video illustrated generation",()=>{
  it("infers a blank goal and renders narration and a scene in one uninterrupted job",async()=>{
    ai.parse.mockResolvedValueOnce({output_parsed:plan}).mockResolvedValueOnce({output_parsed:illustration});
    const {db,saves,rpc,upload}=database();
    await runLocalClaim(db,{job,tutorial,checkpoint:{ingest}},"worker");
    const planned=saves.find(save=>save.p_stage==="plan")!;
    expect(planned).toMatchObject({p_status:"running",p_progress:30,p_tutorial_patch:{status:"generating",goal:plan.goal,plan:{questions:[]}}});
    expect(planned.p_checkpoint.plan).toMatchObject({goal:plan.goal,questions:[]});
    expect(saves.slice(0,-1).every(save=>save.p_status==="running")).toBe(true);
    expect(saves.at(-1)).toMatchObject({p_stage:"ready",p_status:"completed",p_tutorial_patch:{status:"ready",scene:{mode:"illustrated",quality:{approved:true}}}});
    expect(saves.at(-1)!.p_tutorial_patch.scene?.assets.map(asset=>asset.kind)).toEqual(["scene","narration","poster"]);
    expect(ai.parse).toHaveBeenCalledTimes(2);
    expect(JSON.parse(ai.parse.mock.calls[0][0].input[0].content[0].text).spokenInstructions).toBe(ingest.transcript);
    expect(JSON.parse(ai.parse.mock.calls[1][0].input[0].content[0].text).plan.questions).toEqual([]);
    expect(ai.speech).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls.filter(([name])=>name==="reserve_job_cost")).toHaveLength(3);
    expect(rpc.mock.calls.filter(([name])=>name==="settle_job_cost")).toHaveLength(3);
  });

  it("restores the inferred plan after a restart without paying to analyze again",async()=>{
    ai.parse.mockResolvedValueOnce({output_parsed:illustration});
    const {db,saves,rpc}=database();
    await runLocalClaim(db,{job,tutorial,checkpoint:{ingest,plan}},"worker");
    expect(ai.parse).toHaveBeenCalledTimes(1);
    expect(saves.find(save=>save.p_stage==="plan")?.p_tutorial_patch).toMatchObject({goal:plan.goal,plan:{questions:[]}});
    expect(saves.at(-1)?.p_status).toBe("completed");
    expect(rpc.mock.calls.some(([name,args])=>name==="reserve_job_cost"&&String(args.p_reservation_id).startsWith("local-plan-"))).toBe(false);
  });

  it("retries scene validation failures from saved steps instead of requesting more context",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    ai.parse.mockResolvedValue({output_parsed:{...illustration,gestures:[{...illustration.gestures[0],objectId:"missing"}]}});
    const first=database();
    await runLocalClaim(first.db,{job,tutorial,checkpoint:{ingest,plan}},"worker");
    const failed=first.saves.at(-1)!;
    expect(failed).toMatchObject({p_status:"failed",p_tutorial_patch:{status:"failed"},p_checkpoint:{illustrationAttempts:3,plan:{questions:[]}},p_message:expect.stringContaining("Retry")});
    expect(ai.parse).toHaveBeenCalledTimes(3);
    ai.parse.mockReset().mockResolvedValueOnce({output_parsed:illustration});
    const resumed=database();
    await runLocalClaim(resumed.db,{job,tutorial,checkpoint:failed.p_checkpoint},"worker");
    expect(ai.parse).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ai.parse.mock.calls[0][0].input[0].content[0].text).previousValidationError).toContain("gesture");
    expect(resumed.saves.at(-1)).toMatchObject({p_status:"completed",p_checkpoint:{illustrationAttempts:4}});
  });

  it("preserves the budget pause before the first model request",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const {db,saves}=database({denyBudget:true});
    await runLocalClaim(db,{job,tutorial,checkpoint:{ingest}},"worker");
    expect(ai.parse).not.toHaveBeenCalled();
    expect(saves.at(-1)?.p_status).toBe("budget_paused");
  });

  it("honors cancellation between inferred steps and animation",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    ai.parse.mockResolvedValueOnce({output_parsed:plan});
    const {db,saves}=database({cancelAtPlan:true});
    await runLocalClaim(db,{job,tutorial,checkpoint:{ingest}},"worker");
    expect(ai.parse).toHaveBeenCalledTimes(1);
    expect(ai.speech).not.toHaveBeenCalled();
    expect(saves.at(-1)?.p_stage).toBe("plan");
  });
});
