import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { localDatabase, rpc, runLocalClaim } from "../lib/local/pipeline";
loadEnvConfig(process.cwd());
const workerId=`local-${randomUUID()}`;
let stopping=false;
process.on("SIGINT",()=>{stopping=true;console.log("Finishing the current checkpoint, then stopping. A restart resumes queued work.");});
process.on("SIGTERM",()=>{stopping=true;});
async function main() {
  if(!process.env.OPENAI_API_KEY)throw new Error("Add OPENAI_API_KEY to .env.local before starting the worker.");
  const db=localDatabase();
  console.log("Astratorial local worker ready. Mode: illustrated 3D. Waiting for uploaded videos.");
  while(!stopping) {
    try {const claim=await rpc(db,"claim_job",{p_worker_id:workerId,p_lease_seconds:180});if(claim){await runLocalClaim(db,claim,workerId);continue;}}
    catch(error){console.error(error instanceof Error?error.message:"The queue is temporarily unavailable.");}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Local worker could not start.");process.exitCode=1;});
