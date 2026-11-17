import { ProjectId } from "@t3tools/contracts";
import { TeamApiError } from "@t3tools/client-runtime/team";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useTeamStore } from "./teamStore";

vi.mock("./teamClient", () => ({
  teamArtifactRequest: vi.fn().mockImplementation(async (token: string) => ({
    baseUrl: "http://environment.test",
    authorization: token,
  })),
}));

vi.mock("@t3tools/client-runtime/team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/team")>();
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listMembers: vi.fn(),
    listArtifacts: vi.fn(),
    logout: vi.fn(),
  };
});

const team = async () => await import("@t3tools/client-runtime/team");

const WORKSPACE_A = {
  id: "ws_a",
  projectId: ProjectId.make("p_a"),
  name: "Alpha",
  userId: "u_1",
  role: "Owner" as const,
};
const WORKSPACE_B = {
  id: "ws_b",
  projectId: ProjectId.make("p_b"),
  name: "Beta",
  userId: "u_1",
  role: "Viewer" as const,
};

const initialState = useTeamStore.getState();

beforeEach(() => {
  useTeamStore.setState(initialState, true);
  vi.clearAllMocks();
});

describe("teamStore", () => {
  it("clears members and artifacts when the workspace selection changes", async () => {
    const { listMembers, listArtifacts } = await team();
    vi.mocked(listMembers).mockResolvedValue([]);
    vi.mocked(listArtifacts).mockResolvedValue([]);
    useTeamStore.setState({
      token: "token",
      workspaces: [WORKSPACE_A, WORKSPACE_B],
      currentWorkspaceId: "ws_a",
      members: [{ userId: "u_1", name: "Ada", role: "Owner" }],
      artifacts: [],
    });

    useTeamStore.getState().selectWorkspace("ws_b");

    const state = useTeamStore.getState();
    expect(state.currentWorkspaceId).toBe("ws_b");
    expect(state.members).toBeNull();
    expect(state.artifacts).toBeNull();
  });

  it("drops the selection when the workspace list no longer contains it (revoked)", async () => {
    const { listWorkspaces } = await team();
    vi.mocked(listWorkspaces).mockResolvedValue([WORKSPACE_B]);
    useTeamStore.setState({ token: "token", currentWorkspaceId: "ws_a" });

    await useTeamStore.getState().loadWorkspaces();

    expect(useTeamStore.getState().currentWorkspaceId).toBeNull();
  });

  it("keeps the session when only one workspace membership is gone", async () => {
    const { listMembers } = await team();
    vi.mocked(listMembers).mockRejectedValue(
      new TeamApiError({ message: "denied", status: 403, rule: "workspace_membership_required" }),
    );
    useTeamStore.setState({
      token: "token",
      workspaces: [WORKSPACE_A, WORKSPACE_B],
      currentWorkspaceId: "ws_a",
      members: [{ userId: "u_1", name: "Ada", role: "Owner" }],
    });

    await useTeamStore.getState().loadMembers();

    const state = useTeamStore.getState();
    expect(state.currentWorkspaceId).toBeNull();
    expect(state.members).toBeNull();
    // The gateway session still works for the member's other workspaces.
    expect(state.token).toBe("token");
    expect(state.workspacesError).toContain("denied");
  });

  it("clears the session when the token itself is rejected", async () => {
    const { listMembers } = await team();
    vi.mocked(listMembers).mockRejectedValue(
      new TeamApiError({ message: "expired", status: 401, rule: "authentication_required" }),
    );
    useTeamStore.setState({
      token: "token",
      currentWorkspaceId: "ws_a",
      workspaces: [WORKSPACE_A],
    });

    await useTeamStore.getState().loadMembers();

    const state = useTeamStore.getState();
    expect(state.token).toBeNull();
    expect(state.workspaces).toBeNull();
    expect(state.currentWorkspaceId).toBeNull();
    expect(state.workspacesError).toContain("expired");
  });

  it("ignores a failure from a workspace that is no longer selected", async () => {
    const { listMembers } = await team();
    let reject: (error: unknown) => void = () => undefined;
    vi.mocked(listMembers).mockImplementation(
      () => new Promise((_, rejectPromise) => (reject = rejectPromise)),
    );
    useTeamStore.setState({ token: "token", currentWorkspaceId: "ws_a" });

    const pending = useTeamStore.getState().loadMembers();
    useTeamStore.setState({ currentWorkspaceId: "ws_b" });
    reject(new TeamApiError({ message: "old", status: 404, rule: "artifact_not_found" }));
    await pending;

    expect(useTeamStore.getState().currentWorkspaceId).toBe("ws_b");
    expect(useTeamStore.getState().membersError).toBeNull();
  });

  it("marks artifacts as unavailable when the environment has no artifact route", async () => {
    const { listArtifacts } = await team();
    vi.mocked(listArtifacts).mockRejectedValue(
      new TeamApiError({ message: "missing", status: 404, rule: "artifact_not_found" }),
    );
    useTeamStore.setState({ token: "token", currentWorkspaceId: "ws_a" });

    await useTeamStore.getState().loadArtifacts();

    const state = useTeamStore.getState();
    expect(state.artifactsUnavailable).toBe(true);
    expect(state.artifacts).toEqual([]);
  });

  it("keeps the workspace selected when only the artifact route denies the member", async () => {
    const { listArtifacts } = await team();
    vi.mocked(listArtifacts).mockRejectedValue(
      new TeamApiError({
        message: "no team user here",
        status: 403,
        rule: "invited_user_required",
      }),
    );
    useTeamStore.setState({
      token: "token",
      currentWorkspaceId: "ws_a",
      workspaces: [WORKSPACE_A],
    });

    await useTeamStore.getState().loadArtifacts();

    const state = useTeamStore.getState();
    expect(state.currentWorkspaceId).toBe("ws_a");
    expect(state.token).toBe("token");
    expect(state.artifactsError).toContain("no team user here");
  });

  it("reads artifacts with the team bearer on the environment origin", async () => {
    const { listArtifacts } = await team();
    vi.mocked(listArtifacts).mockResolvedValue([]);
    useTeamStore.setState({ token: "team-token", currentWorkspaceId: "ws_a" });

    await useTeamStore.getState().loadArtifacts();

    expect(vi.mocked(listArtifacts).mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "http://environment.test",
      authorization: "team-token",
      workspaceId: "ws_a",
    });
    expect(useTeamStore.getState().artifactBaseUrl).toBe("http://environment.test");
  });

  it("disconnect clears the token and every workspace-scoped row", async () => {
    const { logout } = await team();
    vi.mocked(logout).mockResolvedValue(undefined);
    useTeamStore.setState({
      token: "token",
      workspaces: [WORKSPACE_A],
      currentWorkspaceId: "ws_a",
      members: [{ userId: "u_1", name: "Ada", role: "Owner" }],
    });

    await useTeamStore.getState().disconnect();

    const state = useTeamStore.getState();
    expect(state.token).toBeNull();
    expect(state.currentWorkspaceId).toBeNull();
    expect(state.workspaces).toBeNull();
    expect(state.members).toBeNull();
  });

  it("says so when the server logout fails instead of hiding it", async () => {
    const { logout } = await team();
    vi.mocked(logout).mockRejectedValue(new Error("gateway down"));
    useTeamStore.setState({ token: "token" });

    await useTeamStore.getState().disconnect();

    const state = useTeamStore.getState();
    expect(state.token).toBeNull();
    expect(state.workspacesError).toContain("gateway down");
  });
});
