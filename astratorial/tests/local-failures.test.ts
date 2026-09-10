import { describe, expect, it } from "vitest";
import { localFailureMessage, providerFailure, rendererFailure } from "../lib/local/failures";

describe("actionable and private worker failures",()=>{
  it.each([
    [401,"invalid_api_key","openai_key_rejected","OPENAI_API_KEY"],
    [404,"model_not_found","openai_model_unavailable","model"],
    [429,"insufficient_quota","openai_credit_required","credit"],
    [429,"rate_limit_exceeded","openai_rate_limited","Wait a minute"],
    [503,null,"openai_unavailable","internet connection"],
  ])("classifies provider status %s without relying on its raw message",(status,code,expected,text)=>{
    const failure=providerFailure(status as number,code);
    expect(failure.code).toBe(expected);expect(failure.message).toContain(text as string);
  });
  it.each([
    ["browserType.launch: Executable doesn't exist at /private/path/chromium","renderer_browser_missing","npx playwright install chromium"],
    ["THREE.WebGLRenderer: Error creating WebGL context.","renderer_webgl_failed","3D renderer"],
    ["page.waitForFunction: Timeout 30000ms exceeded.","renderer_timed_out","took too long"],
    ["Could not resolve 'three'","renderer_dependency_missing","npm install"],
  ])("gives a repair for %s",(message,code,text)=>{
    const failure=rendererFailure(new Error(message));
    expect(failure.code).toBe(code);expect(failure.message).toContain(text);expect(failure.message).not.toContain("/private/path");
  });
  it("falls back to the failing stage while keeping raw secrets out",()=>{
    const failure=localFailureMessage(new Error("https://signed.invalid?token=secret"),"analyze");
    expect(failure.message).toContain("Understanding your video");
    expect(failure.message).toContain("completed work are saved");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });
});
