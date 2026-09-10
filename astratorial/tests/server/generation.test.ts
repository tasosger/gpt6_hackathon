import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../../lib/server/api";
import { ownedTutorial, newTutorial, createTutorialSchema } from "../../lib/server/tutorials";
import { requireUser } from "../../lib/supabase/server";
import { AppError } from "../../lib/server/errors";
import type { GenerationJob, TutorialPlan } from "../../lib/contracts";

const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock("../../lib/supabase/server",()=>({requireUser:vi.fn(),currentUser:vi.fn(),supabaseServer:vi.fn(),supabaseAdmin:()=>({rpc:mocks.rpc})}));
vi.mock("../../lib/server/tutorials",async(importOriginal)=>({...await importOriginal<typeof import("../../lib/server/tutorials")>(),ownedTutorial:vi.fn()}));

const ownerId="10000000-0000-4000-8000-000000000001";
const tutorialId="10000000-0000-4000-8000-000000000002";
const job:GenerationJob={id:"10000000-0000-4000-8000-000000000003",tutorialId,revision:1,kind:"generate",status:"queued",stage:"ingest",progress:0,message:"Queued",budgetUsd:25,spentUsd:0,reservedUsd:0,createdAt:"now",updatedAt:"now",error:null};
const plan:TutorialPlan={version:1,title:"Pasta",goal:"Make pasta",description:"Pasta with sauce",category:"cooking",difficulty:"Beginner",estimatedMinutes:10,objects:[],steps:[{id:"s1",title:"Boil water",instruction:"Fill the pan",narration:"Fill the pan",durationSeconds:5,objectIds:[],observable:true,completionCriteria:"Pan contains water",sourceIds:[],action:"pour"}],questions:[],sources:[],constraints:[]};
const capture={id:"video",path:`${ownerId}/${tutorialId}/r1/video.mp4`,name:"Kitchen.mp4",mimeType:"video/mp4",size:100,kind:"video" as const,pass:"room" as const};
function draft(){return {...newTutorial(ownerId,createTutorialSchema.parse({})),id:tutorialId,assets:[capture]};}
function generate(){return handleApi(new Request(`http://localhost:3000/api/tutorials/${tutorialId}/generate`,{method:"POST"}));}

beforeEach(()=>{
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY","test-key");
  vi.mocked(requireUser).mockResolvedValue({id:ownerId} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(ownedTutorial).mockResolvedValue(draft());mocks.rpc.mockResolvedValue({data:job,error:null});
});
afterEach(()=>vi.unstubAllEnvs());

describe("automatic illustrated generation endpoint",()=>{
  it("queues a local job without an extra worker setting, goal, plan, or measurements",async()=>{
    const response=await generate();
    expect(response.status).toBe(202);expect(await response.json()).toEqual({job});
    expect(ownedTutorial).toHaveBeenCalledWith(tutorialId,ownerId);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("enqueue_job",{p_tutorial_id:tutorialId,p_owner_id:ownerId,p_kind:"generate"});
  });

  it("does not gate illustrated generation on questions in an older plan",async()=>{
    vi.mocked(ownedTutorial).mockResolvedValue({...draft(),plan:{...plan,questions:[{id:"salt",question:"Do you have salt?",reason:"Optional",required:true}]}});
    expect((await generate()).status).toBe(202);
  });

  it("still requires an uploaded visual capture",async()=>{
    vi.mocked(ownedTutorial).mockResolvedValue({...draft(),assets:[]});
    expect((await generate()).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("still requires authentication and ownership",async()=>{
    vi.mocked(requireUser).mockRejectedValueOnce(new AppError(401,"Sign in first."));
    expect((await generate()).status).toBe(401);expect(mocks.rpc).not.toHaveBeenCalled();
    vi.mocked(ownedTutorial).mockRejectedValueOnce(new AppError(404,"This tutorial is unavailable."));
    expect((await generate()).status).toBe(404);expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
