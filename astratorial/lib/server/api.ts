import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CaptureAssetSchema, GenerationJobSchema, PracticeSessionSchema, TutorialSchema, type AppConfig, type Tutorial } from "@/lib/contracts";
import { currentUser, requireUser, supabaseAdmin, supabaseServer } from "@/lib/supabase/server";
import { services, requireAI, requireWorker, localMode } from "./env";
import { api, body, dbError, fail, assertRequestOrigin } from "./errors";
import { createTutorialSchema, hydrateTutorial, newTutorial, ownedTutorial, publicSnapshot, readableTutorial, updateTutorialSchema, wakeWorker } from "./tutorials";
import { actionSchema, applyPracticeAction, applyStepCheck, unconfirmedMovableObjects } from "./practice";
import { checkStep, askExpert } from "./openai";
import { endVoice, requireWorkerToken, startVoice, voiceInput } from "./voice";

const uuid = z.string().uuid();
const uploadSchema = z.object({tutorialId:uuid,name:z.string().min(1).max(200),mimeType:z.string().max(100),size:z.number().int().positive().max(50_000_000),kind:CaptureAssetSchema.shape.kind,pass:CaptureAssetSchema.shape.pass,clientFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()});
const imageData = z.string().max(1_000_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/);
const json = (value:unknown,status=200) => Response.json(value,{status,headers:{"Cache-Control":"private, no-store"}});

export const handleApi = api(async (request:Request) => {
  const url=new URL(request.url);
  if (!["GET","HEAD","OPTIONS"].includes(request.method)) assertRequestOrigin(request);
  const parts=url.pathname.replace(/^\/api\//,"").split("/").filter(Boolean); const method=request.method;
  if (parts[0]==="config" && method==="GET") {
    const status=services(); const user=status.database ? await currentUser() : null;
    const config:AppConfig={generationMode:localMode()?"illustrated":"measured",configured:status.database&&status.openai&&status.worker,services:status,user:user?{id:user.id,email:user.email||""}:null};return json(config);
  }
  if(parts[0]==="auth") return authRoute(request,parts[1]);
  if(parts[0]==="internal"&&parts[1]==="voice") return internalVoiceRoute(request,uuid.parse(parts[2]),parts[3]);
  if(parts[0]==="tutorials") {
    if(parts.length===1) {
      if(method==="GET") {
        const scope=url.searchParams.get("scope")||"mine";
        if(scope!=="public"&&scope!=="mine")fail(400,"Choose your library or public tutorials.");
        const db=supabaseAdmin();
        if(scope==="public") { const {data,error}=await db.from("tutorials").select("public_data").eq("visibility","public").not("public_data","is",null).order("updated_at",{ascending:false}).limit(48);dbError(error);return json({tutorials:await Promise.all((data||[]).map(row=>hydrateTutorial(TutorialSchema.parse(row.public_data),false,true)))}); }
        const user=await requireUser();const {data,error}=await db.from("tutorials").select("data").eq("owner_id",user.id).order("updated_at",{ascending:false}).limit(100);dbError(error);return json({tutorials:await Promise.all((data||[]).map(row=>hydrateTutorial(TutorialSchema.parse(row.data),true,true)))});
      }
      if(method==="POST") { const user=await requireUser();const input=createTutorialSchema.parse(await body(request));const tutorial=newTutorial(user.id,input);const result=await supabaseAdmin().rpc("create_tutorial",{p_owner_id:user.id,p_data:tutorial});dbError(result.error);return json({tutorial},201); }
    }
    const id=uuid.parse(parts[1]);
    if(parts.length===2) {
      if(method==="GET") {const {tutorial,isOwner}=await readableTutorial(id);return json({tutorial:await hydrateTutorial(tutorial,isOwner)});}
      if(method==="PATCH")return patchTutorial(request,id);
      if(method==="DELETE")return deleteTutorial(id);
    }
    if(parts[2]==="assets"&&method==="GET") {
      const user=await requireUser();const tutorial=await ownedTutorial(id,user.id);const asset=tutorial.assets.find(a=>a.id===parts[3]);if(!asset)fail(404,"This capture is unavailable.");
      const result=await supabaseAdmin().storage.from("captures").createSignedUrl(asset.path,300);dbError(result.error);return json({url:result.data!.signedUrl});
    }
    if(["analyze","generate","export"].includes(parts[2])&&method==="POST") {
      const user=await requireUser(); requireAI();requireWorker(); const tutorial=await ownedTutorial(id,user.id);
      if(!tutorial.assets.some(a=>a.kind==="video"||a.kind==="image"))fail(422,"Add a room video or photos before generating your tutorial.");
      if(parts[2]==="generate"&&!localMode()) {
        if(!tutorial.plan)fail(422,"Analyze your capture and confirm the goal before generating.");
        if(tutorial.plan.questions.some(q=>q.required))fail(422,"Answer the required capture questions and analyze again first.","context_required");
        const triangulatable=(m:Tutorial["measurements"][number])=>new Set(m.observations.map(o=>`${o.assetId}:${o.timestamp}`)).size>=2;
        if(!tutorial.measurements.some(m=>m.purpose==="scale"&&triangulatable(m))||!tutorial.measurements.some(m=>m.purpose==="validation"&&triangulatable(m)))fail(422,"Add a scale measurement and an independent validation measurement, each marked in two different camera views.","measurements_required");
      }
      if(parts[2]==="export"&&!tutorial.scene)fail(409,"Generate the scene before exporting a video.");
      const {data,error}=await supabaseAdmin().rpc("enqueue_job",{p_tutorial_id:id,p_owner_id:user.id,p_kind:parts[2]});dbError(error);const job=GenerationJobSchema.parse(data);await wakeWorker(job.id);return json({job},202);
    }
    if(parts[2]==="adapt"&&method==="POST")return adaptTutorial(id);
    if(parts[2]==="publish"&&method==="POST")return publishTutorial(request,id);
    if(parts[2]==="unpublish"&&method==="POST") {const user=await requireUser();const tutorial=await ownedTutorial(id,user.id);const next={...tutorial,visibility:"private",updatedAt:new Date().toISOString()};const result=await supabaseAdmin().from("tutorials").update({visibility:"private",public_data:null,data:next,updated_at:next.updatedAt}).eq("id",id).eq("owner_id",user.id);dbError(result.error);return json({tutorial:await hydrateTutorial(TutorialSchema.parse(next))});}
  }
  if(parts[0]==="uploads") {
    if(method==="GET"&&parts.length===1) {const user=await requireUser();const tutorialId=uuid.parse(url.searchParams.get("tutorialId"));const tutorial=await ownedTutorial(tutorialId,user.id);const result=await supabaseAdmin().from("uploads").select("id,asset,revision,created_at,client_fingerprint").eq("owner_id",user.id).eq("tutorial_id",tutorialId).eq("revision",tutorial.revision).eq("completed",false).order("created_at",{ascending:false});dbError(result.error);return json({uploads:(result.data||[]).map(row=>({uploadId:row.id,asset:CaptureAssetSchema.parse(row.asset),revision:row.revision,createdAt:row.created_at,clientFingerprint:row.client_fingerprint}))});}
    if(method==="POST"&&parts[2]==="renew")return renewUpload(uuid.parse(parts[1]));
    if(method==="POST"&&parts.length<=2)return parts[1]==="complete"?completeUpload(request):startUpload(request);
  }
  if(parts[0]==="jobs") {
    const user=await requireUser();const id=uuid.parse(parts[1]);const db=supabaseAdmin();const {data:row,error}=await db.from("generation_jobs").select("id,tutorial_id").eq("id",id).eq("owner_id",user.id).maybeSingle();dbError(error);if(!row)fail(404,"This generation job is unavailable.");
    if(method==="GET") {const result=await db.rpc("job_json",{p_id:id});dbError(result.error);return json({job:GenerationJobSchema.parse(result.data),tutorial:await hydrateTutorial(await ownedTutorial(row.tutorial_id,user.id))});}
    if(method==="POST"&&["cancel","resume"].includes(parts[2])) {if(parts[2]==="resume"){requireAI();requireWorker();}const result=await db.rpc("control_job",{p_id:id,p_owner_id:user.id,p_action:parts[2]});dbError(result.error);const job=GenerationJobSchema.parse(result.data);if(parts[2]==="resume")await wakeWorker(job.id);return json({job});}
  }
  if(parts[0]==="practice")return practiceRoute(request,parts);
  if(parts[0]==="realtime"&&parts[1]==="session") {
    const user=await requireUser();
    if(method==="POST"&&parts.length===2) {const input=voiceInput.parse(await body(request));const {tutorial}=await readableTutorial(input.tutorialId);return json(await startVoice(user.id,tutorial,input));}
    if(parts[3]==="context"&&parts[2])return voiceContext(request,uuid.parse(parts[2]),user.id);
    if(method==="DELETE"&&parts[2]) {await endVoice(uuid.parse(parts[2]),user.id);return json({ok:true});}
  }
  fail(404,"This endpoint does not exist.");
});

async function authRoute(request:Request,action:string) {
  if(request.method!=="POST")fail(405,"Use POST for this action.");
  const client=await supabaseServer();
  if(action==="guest") { const {data:existing}=await client.auth.getUser(); if(existing.user)return json({user:{id:existing.user.id,email:existing.user.email||""}}); const {data,error}=await client.auth.signInAnonymously(); if(error||!data.user)fail(503,"We could not start your workspace. Please try again."); return json({user:{id:data.user.id,email:data.user.email||""}}); }
  if(action==="logout") {assertRequestOrigin(request);const {error}=await client.auth.signOut();if(error)fail(503,"We could not sign out. Please try again.");return json({ok:true});}
  const input=await body(request);
  if(action==="otp") {const {email}=z.object({email:z.string().email().max(254)}).parse(input);const {error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:true}});if(error)fail(error.status===429?429:503,"We could not send your sign-in code. Wait a moment and try again.");return json({sent:true});}
  if(action==="verify") {const {email,token}=z.object({email:z.string().email(),token:z.string().regex(/^\d{6,10}$/)}).parse(input);const {data,error}=await client.auth.verifyOtp({email,token,type:"email"});if(error||!data.user)fail(400,"That code is invalid or has expired. Request a new code.");return json({user:{id:data.user.id,email:data.user.email}});}
  fail(404,"This sign-in action is unavailable.");
}

async function patchTutorial(request:Request,id:string) {
  const user=await requireUser();const input=updateTutorialSchema.parse(await body(request));const original=await ownedTutorial(id,user.id);
  if(input.expectedRevision&&input.expectedRevision!==original.revision)fail(409,"This tutorial has changed. Refresh before editing.");
  const {answers,...changes}=input;
  delete changes.expectedRevision;
  if(changes.measurements)for(const measurement of changes.measurements)for(const observation of measurement.observations)if(!original.assets.some(a=>a.id===observation.assetId&&(a.kind==="image"||a.kind==="video")))fail(422,"Each measurement must refer to a photo or video in this capture.");
  let constraints=changes.constraints||original.constraints;
  if(answers) {const entries=Object.entries(answers).filter(([,answer])=>answer.trim());for(const [questionId]of entries)if(!original.plan?.questions.some(q=>q.id===questionId))fail(422,"One of the answers does not match a current question.");constraints=[...constraints,...entries.map(([id,answer])=>`${original.plan!.questions.find(q=>q.id===id)!.question} ${answer.trim()}`)];}
  const changed=Object.entries(changes).some(([key,value])=>JSON.stringify(original[key as keyof Tutorial])!==JSON.stringify(value))||!!answers;
  if(!changed)return json({tutorial:await hydrateTutorial(original)});
  const newRevision=original.plan||original.scene||original.job ? original.revision+1:original.revision;
  const next=TutorialSchema.parse({...original,...changes,constraints,revision:newRevision,slug:changes.title?changes.title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""):original.slug,status:"draft",visibility:"private",scene:null,job:null,thumbnailUrl:null,updatedAt:new Date().toISOString()});
  // A changed goal/answer must be reanalyzed. Measurements alone preserve the plan.
  if(changes.goal!==undefined||changes.referenceUrls!==undefined||changes.constraints!==undefined||answers)next.plan=null;
  const result=await supabaseAdmin().rpc("update_tutorial",{p_id:id,p_owner_id:user.id,p_revision:original.revision,p_data:next});dbError(result.error);return json({tutorial:TutorialSchema.parse(result.data)});
}

async function startUpload(request:Request) {
  const user=await requireUser();const input=uploadSchema.parse(await body(request));let tutorial=await ownedTutorial(input.tutorialId,user.id);
  const allowed={video:/^video\/(mp4|quicktime|webm)$/,image:/^image\/(jpeg|png|webp|heic|heif)$/,audio:/^audio\/(mpeg|mp4|wav|webm|ogg|x-m4a|x-wav)$/,manual:/^application\/pdf$/};
  if(!allowed[input.kind].test(input.mimeType))fail(415,"Choose an MP4, MOV, WebM, photo, audio recording, or PDF manual.");
  if(input.kind==="manual"&&input.size>10_000_000)fail(413,"Choose PDF manuals totaling up to 10 MB.","upload_limit");
  if(tutorial.assets.length>=30)fail(422,"This tutorial already contains 30 captures. Start a new tutorial for more media.");
  if(["analyzing","generating"].includes(tutorial.status))fail(409,"Finish or cancel the current generation before uploading more media.");
  if(tutorial.plan||tutorial.scene||tutorial.job) {
    const next={...tutorial,revision:tutorial.revision+1,status:"draft",visibility:"private",plan:null,scene:null,job:null,thumbnailUrl:null,updatedAt:new Date().toISOString()};
    const revised=await supabaseAdmin().rpc("update_tutorial",{p_id:tutorial.id,p_owner_id:user.id,p_revision:tutorial.revision,p_data:next});dbError(revised.error);tutorial=TutorialSchema.parse(revised.data);
  }
  const id=randomUUID();const name=input.name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-160);const path=`${user.id}/${tutorial.id}/r${tutorial.revision}/${id}-${name}`;
  const asset=CaptureAssetSchema.parse({id,path,name:input.name,mimeType:input.mimeType,size:input.size,kind:input.kind,pass:input.pass});const db=supabaseAdmin();
  const inserted=await db.rpc("register_upload",{p_id:id,p_owner_id:user.id,p_tutorial_id:tutorial.id,p_revision:tutorial.revision,p_asset:asset,p_client_fingerprint:input.clientFingerprint||null});dbError(inserted.error);
  return json(await uploadConfiguration(id,asset),201);
}
async function uploadConfiguration(uploadId:string,asset:z.infer<typeof CaptureAssetSchema>) {
  const result=await supabaseAdmin().storage.from("captures").createSignedUploadUrl(asset.path,{upsert:false});dbError(result.error);
  const base=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);if(base.hostname.endsWith(".supabase.co"))base.hostname=base.hostname.replace(".supabase.co",".storage.supabase.co");
  return {uploadId,asset,endpoint:`${base.origin}/storage/v1/upload/resumable`,headers:{"x-signature":result.data!.token},metadata:{bucketName:"captures",objectName:asset.path,contentType:asset.mimeType,cacheControl:"3600"},chunkSize:6*1024*1024};
}
async function renewUpload(uploadId:string) {
  const user=await requireUser();const db=supabaseAdmin();const {data:upload,error}=await db.from("uploads").select("asset,tutorial_id,revision").eq("id",uploadId).eq("owner_id",user.id).maybeSingle();dbError(error);if(!upload)fail(404,"This upload is unavailable.");
  const tutorial=await ownedTutorial(upload.tutorial_id,user.id);
  if(tutorial.revision!==upload.revision)fail(409,"This capture belongs to an older tutorial revision. Add it to your current draft again.","stale_upload");
  if(["analyzing","generating"].includes(tutorial.status))fail(409,"Finish or cancel the active generation before resuming uploads.");
  const asset=CaptureAssetSchema.parse(upload.asset);const info=await db.storage.from("captures").info(asset.path);
  if(info.data) {
    if(Number(info.data.size)!==asset.size)fail(422,"The stored file size does not match this capture. Remove the incomplete tutorial and upload again.");
    const attached=await db.rpc("complete_upload",{p_id:uploadId,p_owner_id:user.id});dbError(attached.error);return json({completed:true,uploadId,asset,tutorial:TutorialSchema.parse(attached.data)});
  }
  return json(await uploadConfiguration(uploadId,asset));
}
async function completeUpload(request:Request) {
  const user=await requireUser();const {uploadId}=z.object({uploadId:uuid}).parse(await body(request));const db=supabaseAdmin();const {data:upload,error}=await db.from("uploads").select("asset,tutorial_id").eq("id",uploadId).eq("owner_id",user.id).maybeSingle();dbError(error);if(!upload)fail(404,"This upload is unavailable.");
  const asset=CaptureAssetSchema.parse(upload.asset);const result=await db.storage.from("captures").info(asset.path);if(result.error||!result.data)fail(409,"This upload is still incomplete. Resume it and try again.");
  if(Number(result.data.size)!==asset.size)fail(422,"The uploaded file size does not match. Please upload this file again.");
  const attached=await db.rpc("complete_upload",{p_id:uploadId,p_owner_id:user.id});dbError(attached.error);return json({tutorial:TutorialSchema.parse(attached.data),asset});
}

async function adaptTutorial(id:string) {
  const user=await requireUser();const db=supabaseAdmin();const {data:source,error}=await db.from("tutorials").select("public_data").eq("id",id).eq("visibility","public").not("public_data","is",null).maybeSingle();dbError(error);
  if(!source)fail(404,"This published tutorial is unavailable.");
  const published=TutorialSchema.parse(source.public_data);
  const tutorial={...newTutorial(user.id,createTutorialSchema.parse({title:published.title,goal:published.goal,referenceUrls:published.plan?.sources.map(source=>source.url).filter(url=>/^https?:\/\//.test(url)).slice(0,20)||[]})),adaptedFrom:id,...(published.plan?{adaptationPlan:published.plan}:{})};
  const result=await db.rpc("create_tutorial",{p_owner_id:user.id,p_data:tutorial});dbError(result.error);return json({tutorial},201);
}

async function publishTutorial(request:Request,id:string) {
  const user=await requireUser();const tutorial=await ownedTutorial(id,user.id);if(!tutorial.scene?.quality.approved||!tutorial.plan)fail(409,"Finish generating and verifying the tutorial before sharing.");
  const input=request.headers.get("content-type")?.includes("application/json")?z.object({confirm:z.boolean().optional(),scope:z.literal("task_area").optional()}).parse(await body(request)):{};
  const db=supabaseAdmin();const {data:completed,error}=await db.from("generation_jobs").select("checkpoint").eq("tutorial_id",id).eq("revision",tutorial.revision).eq("kind","publish").eq("status","completed").order("created_at",{ascending:false}).limit(1).maybeSingle();dbError(error);
  if(completed?.checkpoint?.publicScene) {
    const snapshot=publicSnapshot(tutorial,completed.checkpoint.publicScene);
    if(!input.confirm)return json({preview:await hydrateTutorial(snapshot,false),requiresConfirmation:true});
    const updated={...tutorial,visibility:"public" as const,updatedAt:new Date().toISOString()};const result=await db.from("tutorials").update({visibility:"public",public_data:snapshot,data:updated,updated_at:updated.updatedAt}).eq("id",id).eq("owner_id",user.id).eq("data->>revision",String(tutorial.revision)).select("id").maybeSingle();dbError(result.error);if(!result.data)fail(409,"This tutorial changed before it could be published.");return json({tutorial:await hydrateTutorial(updated)});
  }
  requireWorker();requireAI();const result=await db.rpc("enqueue_job",{p_tutorial_id:id,p_owner_id:user.id,p_kind:"publish"});dbError(result.error);const job=GenerationJobSchema.parse(result.data);await wakeWorker(job.id);return json({job,requiresConfirmation:true},202);
}

async function deleteTutorial(id:string) {
  const user=await requireUser();await ownedTutorial(id,user.id);const db=supabaseAdmin();
  const {data:jobs,error}=await db.from("generation_jobs").select("id").eq("tutorial_id",id).in("status",["queued","running","needs_context","budget_paused","failed"]);dbError(error);
  for(const job of jobs||[]){const result=await db.rpc("control_job",{p_id:job.id,p_owner_id:user.id,p_action:"cancel"});dbError(result.error);}
  const unpublish=await db.from("tutorials").update({visibility:"private",public_data:null}).eq("id",id).eq("owner_id",user.id);dbError(unpublish.error);
  for(const bucket of ["captures","tutorial-assets"]) {
    const paths:string[]=[];
    async function visit(prefix:string){let offset=0;while(true){const {data,error}=await db.storage.from(bucket).list(prefix,{limit:1000,offset});dbError(error);for(const item of data||[]){const path=`${prefix}/${item.name}`;if(item.id)paths.push(path);else await visit(path);}if((data?.length||0)<1000)break;offset+=1000;}}
    await visit(`${user.id}/${id}`);for(let i=0;i<paths.length;i+=100){const result=await db.storage.from(bucket).remove(paths.slice(i,i+100));dbError(result.error);}
  }
  const result=await db.from("tutorials").delete().eq("id",id).eq("owner_id",user.id);dbError(result.error);return json({ok:true});
}

async function loadPractice(id:string,ownerId:string) {
  const {data,error}=await supabaseAdmin().from("practice_sessions").select("data").eq("id",id).eq("owner_id",ownerId).maybeSingle();dbError(error);if(!data)fail(404,"This practice session is unavailable.");return PracticeSessionSchema.parse(data.data);
}
async function practiceRoute(request:Request,parts:string[]) {
  const user=await requireUser();const db=supabaseAdmin();
  if(parts.length===1&&request.method==="POST") {const {tutorialId}=z.object({tutorialId:uuid}).parse(await body(request));const {tutorial}=await readableTutorial(tutorialId);if(!tutorial.plan||!tutorial.scene?.quality.approved)fail(409,"Finish generating the tutorial before practicing.");const now=new Date().toISOString();const session=PracticeSessionSchema.parse({id:randomUUID(),ownerId:user.id,tutorialId,tutorialRevision:tutorial.revision,currentStepIndex:0,version:0,status:"calibrating",completedStepIds:[],consecutiveComplete:0,calibration:null,createdAt:now,updatedAt:now});const result=await db.from("practice_sessions").insert({id:session.id,owner_id:user.id,tutorial_id:tutorialId,data:session});dbError(result.error);return json({session},201);}
  const id=uuid.parse(parts[1]);const session=await loadPractice(id,user.id);const {tutorial}=await readableTutorial(session.tutorialId);
  if(request.method==="GET") {if(session.tutorialRevision!==tutorial.revision)fail(409,"This tutorial revision changed. Start a new practice session.","stale_session");return json({session});}
  if(request.method==="PATCH") {const input=actionSchema.parse(await body(request));const next=applyPracticeAction(session,tutorial,input);const result=await db.rpc("commit_practice",{p_id:id,p_owner_id:user.id,p_expected_version:input.version,p_next:next});dbError(result.error);return json({session:PracticeSessionSchema.parse(result.data)});}
  if(request.method==="POST"&&parts[2]==="check") {
    const input=z.object({version:z.number().int().nonnegative(),stepId:z.string(),frames:z.array(imageData).min(1).max(2)}).parse(await body(request,2_100_000));
    const step=tutorial.plan?.steps[session.currentStepIndex];if(!step||step.id!==input.stepId||input.version!==session.version||session.tutorialRevision!==tutorial.revision)fail(409,"This step changed while the camera was checking.","stale_check");
    if(!step.observable) {
      const check=await checkStep(step,[]);const next=applyStepCheck(session,tutorial,check,input.version);const result=await db.rpc("commit_practice",{p_id:id,p_owner_id:user.id,p_expected_version:input.version,p_next:next});dbError(result.error);return json({check,session:PracticeSessionSchema.parse(result.data)});
    }
    requireAI();
    const unmapped=unconfirmedMovableObjects(session,tutorial);
    if(unmapped.length)fail(422,"Confirm the current position of each movable object before checking this step.","object_alignment_required");
    const checkId=randomUUID();const reservation=Math.max(0.15,Number(process.env.PRACTICE_CHECK_RESERVATION_USD)||0.15);const locked=await db.rpc("begin_practice_check",{p_id:id,p_owner_id:user.id,p_version:input.version,p_check_id:checkId,p_reservation:reservation,p_frame:input.frames[input.frames.length-1],p_step_id:step.id});dbError(locked.error);
    try {const check=await checkStep(step,input.frames);const next=applyStepCheck(session,tutorial,check,input.version);const result=await db.rpc("commit_practice",{p_id:id,p_owner_id:user.id,p_expected_version:input.version,p_next:next,p_check_id:checkId});dbError(result.error);return json({check,session:PracticeSessionSchema.parse(result.data)});}
    finally {await db.from("practice_sessions").update({pending_check:null}).eq("id",id).eq("pending_check",checkId);}
  }
  fail(405,"This practice action is unavailable.");
}

async function voiceContext(request:Request,id:string,ownerId:string) {
  const db=supabaseAdmin();const {data:voice,error}=await db.from("voice_sessions").select("tutorial_id,tutorial_revision,viewer_step_id,viewer_action,viewer_version,camera_mode,status,spent_usd,expert_spent_usd,budget_usd,expires_at").eq("id",id).eq("owner_id",ownerId).maybeSingle();dbError(error);
  if(!voice)fail(404,"This conversation is unavailable.");
  if(request.method==="GET")return json({stepId:voice.viewer_step_id,cameraMode:voice.camera_mode,action:voice.viewer_action,version:voice.viewer_version,status:voice.status,budgetUsd:voice.budget_usd,spentUsd:Number(voice.spent_usd)+Number(voice.expert_spent_usd)});
  if(request.method!=="POST")fail(405,"This conversation action is unavailable.");
  if(!["starting","active"].includes(voice.status)||Date.parse(voice.expires_at)<=Date.now())fail(409,"This conversation has ended.");
  const input=z.object({stepId:z.string().max(200),cameraMode:z.enum(["first","third","free"])}).parse(await body(request));
  const {tutorial}=await readableTutorial(voice.tutorial_id);
  if(tutorial.revision!==voice.tutorial_revision||!tutorial.plan?.steps.some(step=>step.id===input.stepId))fail(409,"This step does not belong to the current conversation.");
  const result=await db.from("voice_sessions").update({viewer_step_id:input.stepId,camera_mode:input.cameraMode}).eq("id",id).eq("owner_id",ownerId);dbError(result.error);
  return json({stepId:input.stepId,cameraMode:input.cameraMode});
}

async function internalVoiceRoute(request:Request,id:string,action:string) {
  requireWorkerToken(request);if(request.method!=="POST"||action!=="tool")fail(404,"Unknown worker endpoint.");
  const input=z.object({name:z.enum(["get_current_step","repeat_step","pause_practice","resume_practice","previous_step","next_step","request_visual_check","ask_astra"]),arguments:z.record(z.string(),z.unknown()).default({}),requestId:z.string().min(1).max(200).optional()}).parse(await body(request));
  const db=supabaseAdmin();const {data:voice,error}=await db.from("voice_sessions").select("*").eq("id",id).maybeSingle();dbError(error);if(!voice||!["starting","active"].includes(voice.status)||Date.parse(voice.expires_at)<=Date.now()||Number(voice.spent_usd)+Number(voice.expert_spent_usd)>=2)fail(409,"This conversation has ended.");
  const {data:row,error:tError}=await db.from("tutorials").select("data,public_data,visibility,owner_id").eq("id",voice.tutorial_id).maybeSingle();dbError(tError);if(!row||(row.owner_id!==voice.owner_id&&row.visibility!=="public"))fail(404,"This tutorial is unavailable.");
  const tutorial=TutorialSchema.parse(row.owner_id===voice.owner_id?row.data:row.public_data);
  if(voice.tutorial_revision!==tutorial.revision)fail(409,"The tutorial changed. Start a new conversation.");
  const session=voice.practice_session_id?await loadPractice(voice.practice_session_id,voice.owner_id):null;
  if(session&&session.tutorialRevision!==tutorial.revision)fail(409,"The tutorial changed. Start a new conversation.");
  const steps=tutorial.plan?.steps||[];
  const index=session?.currentStepIndex??Math.max(0,steps.findIndex(step=>step.id===voice.viewer_step_id));
  const step=steps[index];
  if(!step)fail(409,"This tutorial has no playable steps.");
  if(input.name==="ask_astra") {
    const {question}=z.object({question:z.string().trim().min(1).max(1500)}).strict().parse(input.arguments);
    if(!input.requestId)fail(400,"An expert request identifier is required.");
    requireAI();const charged=await db.rpc("charge_voice_expert",{p_id:id,p_request_id:input.requestId,p_amount:0.35});dbError(charged.error);
    if(!charged.data)return json({guidance:"The remaining voice allowance cannot cover another expert answer, or this question was already submitted. Please use the reviewed tutorial instructions."});
    let frame:{dataUrl:string;capturedAt:string}|undefined;
    if(session) {
      const currentFrame=await db.from("practice_sessions").select("last_frame,frame_step_id,frame_expires_at").eq("id",session.id).eq("owner_id",voice.owner_id).maybeSingle();dbError(currentFrame.error);
      if(currentFrame.data?.last_frame&&currentFrame.data.frame_step_id===step.id&&Date.parse(currentFrame.data.frame_expires_at)>Date.now())frame={dataUrl:currentFrame.data.last_frame,capturedAt:new Date(Date.parse(currentFrame.data.frame_expires_at)-90_000).toISOString()};
    }
    return json({expert:await askExpert(tutorial,step.id,question,frame),step,frameCapturedAt:frame?.capturedAt});
  }
  z.object({}).strict().parse(input.arguments);
  if(input.name==="get_current_step")return json({session,step,cameraMode:voice.camera_mode});
  if(input.name==="request_visual_check") {
    if(session&&session.status==="active") {const notice=await db.from("voice_sessions").update({viewer_step_id:step.id,viewer_action:input.name,viewer_version:Number(voice.viewer_version||0)+1}).eq("id",id);dbError(notice.error);}
    return json({session,step,guidance:session?.status==="active"?"A camera check has been requested in the practice interface. Do not claim it is complete until the authoritative result arrives. The user can also tap Check this step.":"Open and align live practice first, then use Check this step. The voice channel cannot inspect the camera directly."});
  }
  if(!session) {
    const nextIndex=Math.max(0,Math.min(steps.length-1,index+(input.name==="next_step"?1:input.name==="previous_step"?-1:0)));
    const result=await db.from("voice_sessions").update({viewer_step_id:steps[nextIndex].id,viewer_action:input.name,viewer_version:Number(voice.viewer_version||0)+1}).eq("id",id);dbError(result.error);
    return json({step:steps[nextIndex],stepId:steps[nextIndex].id,cameraMode:voice.camera_mode,action:input.name,guidance:input.name==="pause_practice"||input.name==="resume_practice"?"The user is watching a tutorial. Practice is not active.":"The watched tutorial step has been selected."});
  }
  if(input.name==="next_step")return json({session,step,guidance:"Ask the user to confirm completion with I’ve done this on screen, or use the camera check. Voice cannot independently mark a physical action complete."});
  const practiceAction=input.name==="repeat_step"?"repeat":input.name==="previous_step"?"previous":input.name==="resume_practice"?"resume":"pause";
  const next=applyPracticeAction(session,tutorial,{action:practiceAction,version:session.version});const result=await db.rpc("commit_practice",{p_id:session.id,p_owner_id:voice.owner_id,p_expected_version:session.version,p_next:next});dbError(result.error);
  const notice=await db.from("voice_sessions").update({viewer_step_id:steps[next.currentStepIndex].id,viewer_action:input.name,viewer_version:Number(voice.viewer_version||0)+1}).eq("id",id);dbError(notice.error);
  return json({session:result.data,step:steps[next.currentStepIndex]});
}
