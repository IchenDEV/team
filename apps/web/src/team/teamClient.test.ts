import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: vi.fn(() => {
    throw new Error("primary environment disabled");
  }),
}));

import { teamEnvironmentUrl } from "./teamClient";

describe("teamEnvironmentUrl", () => {
  it("returns no URL when the desktop has no local environment to prefill from", () => {
    expect(teamEnvironmentUrl()).toBe("");
  });
});
