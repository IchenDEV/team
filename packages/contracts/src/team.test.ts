import { describe, expect, it } from "vite-plus/test";

import { TeamError, teamErrorMessage } from "./team.ts";

describe("teamErrorMessage", () => {
  it("tells the caller a reserved identifier is kept by a deleted workspace and what to do", () => {
    const message = new TeamError({ rule: "workspace_identifier_reserved" }).message;
    expect(message).toMatch(/reserved/);
    expect(message).toMatch(/deleted workspace/);
    expect(message).toMatch(/new identifier/);
  });

  it("keeps every other code as its own message", () => {
    for (const rule of ["storage_failure", "workspace_not_configured", "owner_required"] as const)
      expect(teamErrorMessage(rule)).toBe(rule);
  });
});
