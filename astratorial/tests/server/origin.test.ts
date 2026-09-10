import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRequestOrigin } from "../../lib/server/errors";

beforeEach(() => {vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:4173");vi.stubEnv("ASTRATORIAL_PUBLIC_URL", "https://demo.trycloudflare.com");});
afterEach(() => vi.unstubAllEnvs());
const request = (origin:string) => new Request("http://0.0.0.0:4173/api/auth/guest", {method:"POST",headers:{Origin:origin,"X-Forwarded-Host":"attacker.example","X-Forwarded-Proto":"https"}});

describe("local browser origin behind the server bind address", () => {
  it("accepts the configured localhost and phone links even when Next reports 0.0.0.0", () => {
    expect(() => assertRequestOrigin(request("http://localhost:4173"))).not.toThrow();
    expect(() => assertRequestOrigin(request("https://demo.trycloudflare.com"))).not.toThrow();
  });
  it("rejects other sites, wrong ports and forged forwarding headers", () => {
    for (const origin of ["http://localhost:4174","https://attacker.example","https://attacker.trycloudflare.com","null"]) {
      expect(() => assertRequestOrigin(request(origin))).toThrow("unrecognized address");
    }
  });
  it("does not grant permission from an invalid configured URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "not-a-url");
    expect(() => assertRequestOrigin(request("http://localhost:4173"))).toThrow();
  });
});
