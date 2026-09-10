import { describe, expect, it } from "vitest";
import { api, dbError } from "../../lib/server/errors";

describe("database upload limits", () => {
  it.each([
    [
      "upload limit: this account has used its 500 MB capture allowance. Delete an unused tutorial before adding more",
      "Upload limit: this guest library has used its 500 MB capture allowance. Delete an unused tutorial before adding more",
    ],
    [
      "upload limit: 30 files and 2 GB per tutorial, 5 GB per account",
      "Upload limit: 30 files and 2 GB per tutorial, 5 GB per guest library",
    ],
    [
      "upload limit: PDF manuals together must fit within 10 MB",
      "Upload limit: PDF manuals together must fit within 10 MB",
    ],
  ])("preserves the quota and recovery guidance from legacy SQL: %s", async (message, expected) => {
    const response = await api(async () => {
      dbError({code:"P0001",message});
      return Response.json({ok:true});
    })();

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({code:"upload_limit",error:expected});
  });
});
