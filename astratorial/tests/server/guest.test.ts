import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../../lib/server/api";

const mocks = vi.hoisted(() => ({getUser:vi.fn(),signInAnonymously:vi.fn(),currentUser:vi.fn()}));
vi.mock("../../lib/supabase/server", () => ({
  supabaseServer:async()=>({auth:mocks}),supabaseAdmin:vi.fn(),currentUser:mocks.currentUser,requireUser:vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({data:{user:null},error:null});
});
afterEach(() => vi.unstubAllEnvs());
const guest = () => handleApi(new Request("http://localhost:4173/api/auth/guest", {method:"POST"}));

describe("guest sessions", () => {
  it.each(["anonymous_provider_disabled","signup_disabled"])("explains %s without requiring an account and preserves the local-video recovery path", async (code) => {
    mocks.signInAnonymously.mockResolvedValue({data:{user:null},error:{code,message:"private provider trace"}});
    const response = await guest();
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.code).toBe("guest_session_disabled");
    expect(data.error).toContain("Guest uploads haven’t been enabled for this app yet");
    expect(data.error).toContain("The app owner needs to fix this");
    expect(data.error).toContain("video is still on this device");
    expect(data.error).not.toContain("private provider trace");
  });
  it("offers guest recovery when verification fails", async () => {
    mocks.signInAnonymously.mockResolvedValue({data:{user:null},error:{code:"captcha_failed"}});
    const response = await guest();
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data).toMatchObject({code:"guest_verification_required",error:expect.stringContaining("This app is requesting a verification step that isn’t available here")});
    expect(data.error).toContain("The app owner needs to fix this");
    expect(data.error).not.toMatch(/account|settings|sign.in/i);
  });
  it("reports rate limits without encouraging immediate automatic retries", async () => {
    mocks.signInAnonymously.mockResolvedValue({data:{user:null},error:{status:429}});
    const response = await guest();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({code:"guest_rate_limited",error:expect.stringContaining("Wait a minute")});
  });
  it("reuses an existing session instead of creating another guest", async () => {
    mocks.getUser.mockResolvedValue({data:{user:{id:"owner",email:"legacy@example.com"}},error:null});
    const response = await guest();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({user:{id:"owner"}});
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });
  it("creates an anonymous session without exposing personal identity", async () => {
    mocks.signInAnonymously.mockResolvedValue({data:{user:{id:"guest",email:"",is_anonymous:true}},error:null});
    const response = await guest();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({user:{id:"guest"}});
    expect(mocks.signInAnonymously).toHaveBeenCalledOnce();
  });
  it("does not reuse an identity that failed validation", async () => {
    mocks.getUser.mockResolvedValue({data:{user:{id:"expired"}},error:{message:"invalid session"}});
    mocks.signInAnonymously.mockResolvedValue({data:{user:{id:"guest"}},error:null});
    const response = await guest();
    expect(await response.json()).toEqual({user:{id:"guest"}});
    expect(mocks.signInAnonymously).toHaveBeenCalledOnce();
  });
  it("reports a failed connection without exposing provider diagnostics", async () => {
    mocks.signInAnonymously.mockResolvedValue({data:{user:null},error:{message:"private provider trace"}});
    const response = await guest();
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data).toMatchObject({code:"guest_session_failed",error:expect.stringContaining("Check the connection and try again")});
    expect(data.error).not.toContain("private provider trace");
  });
  it("returns only the opaque session identity in public configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL","https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY","public-test-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","private-test-key");
    mocks.currentUser.mockResolvedValue({id:"owner",email:"legacy@example.com"});
    const response = await handleApi(new Request("http://localhost:4173/api/config"));
    expect(response.status).toBe(200);
    expect((await response.json()).user).toEqual({id:"owner"});
  });
});
