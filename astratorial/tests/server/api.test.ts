import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../../lib/server/api";

const keys=["NEXT_PUBLIC_SUPABASE_URL","NEXT_PUBLIC_SUPABASE_ANON_KEY","SUPABASE_SERVICE_ROLE_KEY","OPENAI_API_KEY","MODAL_WORKER_URL","MODAL_WORKER_TOKEN","MODAL_VOICE_URL"];
beforeEach(()=>{for(const key of keys)vi.stubEnv(key,"");});
afterEach(()=>vi.unstubAllEnvs());
describe("API configuration boundaries",()=>{
  it("reports missing services without pretending a local account is signed in",async()=>{const response=await handleApi(new Request("http://localhost:3000/api/config"));expect(response.status).toBe(200);expect(await response.json()).toEqual({configured:false,services:{database:false,openai:false,worker:false},user:null});});
  it("does not expose configured provider credentials in the public configuration",async()=>{vi.stubEnv("OPENAI_API_KEY","test-private-openai-value");vi.stubEnv("MODAL_WORKER_URL","https://worker.example/wake");vi.stubEnv("MODAL_WORKER_TOKEN","test-private-worker-value");const response=await handleApi(new Request("http://localhost:3000/api/config"));const text=await response.text();expect(text).not.toContain("test-private");expect(JSON.parse(text).services).toEqual({database:false,openai:true,worker:true});});
  it("returns actionable setup-required responses for persistence without Supabase",async()=>{const response=await handleApi(new Request("http://localhost:3000/api/tutorials?scope=mine"));expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:"setup_required",error:expect.stringContaining("Supabase")});});
  it("rejects cross-origin mutations before accessing accounts or providers",async()=>{const response=await handleApi(new Request("http://localhost:3000/api/tutorials",{method:"POST",headers:{Origin:"https://attacker.example","Content-Type":"application/json"},body:'{"goal":"test"}'}));expect(response.status).toBe(403);});
  it("requires a valid server token for voice tool dispatch",async()=>{const response=await handleApi(new Request("http://localhost:3000/api/internal/voice/10000000-0000-4000-8000-000000000001/tool",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"name":"get_current_step"}'}));expect(response.status).toBe(401);});
});
