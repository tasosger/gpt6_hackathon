import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { localDatabase, rpc, runLocalClaim } from "../lib/local/pipeline";
import { writeWorkerHeartbeat } from "../lib/local/runtime";
loadEnvConfig(process.cwd());
const workerId=`local-${randomUUID()}`;
let stopping=false;
process.on("SIGINT",()=>{stopping=true;console.log("Finishing the current checkpoint, then stopping. A restart resumes queued work.");});
process.on("SIGTERM",()=>{stopping=true;});
async function main() {
  if(!process.env.OPENAI_API_KEY)throw new Error("Add OPENAI_API_KEY to .env.local before starting the worker.");
  const db=localDatabase();
  let queueConnected=false;
  let heartbeatWriting=false;
  const heartbeat=async()=>{
    if(heartbeatWriting)return;
    heartbeatWriting=true;
    try {await writeWorkerHeartbeat(queueConnected);} catch {console.error("Worker status could not be saved locally.");}
    finally {heartbeatWriting=false;}
  };
  await heartbeat();
  const timer=setInterval(()=>void heartbeat(),5000);
  console.log("Astratorial local worker ready. Mode: illustrated 3D. Waiting for uploaded videos.");
  try {
    while(!stopping) {
      try {const claim=await rpc(db,"claim_job",{p_worker_id:workerId,p_lease_seconds:180});queueConnected=true;await heartbeat();if(claim){await runLocalClaim(db,claim,workerId);continue;}}
      catch {queueConnected=false;await heartbeat();console.error("The job queue is temporarily unavailable. Check the database connection.");}
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
  } finally {clearInterval(timer);}
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Local worker could not start.");process.exitCode=1;});
