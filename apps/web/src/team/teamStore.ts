import {
  isSessionLost,
  isTeamApiError,
  isWorkspaceAccessLost,
  listArtifacts,
  listMembers,
  listWorkspaces,
  inviteMember,
  login,
  logout,
  removeMember,
  setMemberRole,
  type TeamArtifact,
  type TeamMember,
  type TeamRole,
  type TeamWorkspaceAccess,
} from "@t3tools/client-runtime/team";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage } from "../lib/storage";
import { teamArtifactRequest } from "./teamClient";

const DEFAULT_TEAM_GATEWAY_URL = "http://127.0.0.1:3781";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Team ids are `[A-Za-z0-9_-]{1,64}`; a name that is not ASCII still needs a stable id. */
const invitedUserId = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 0 && slug.length <= 61) return `u_${slug}`;
  let hash = 2166136261;
  for (const character of name.trim()) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  }
  return `u_${(hash >>> 0).toString(36)}`;
};

export interface TeamState {
  /** Gateway the user last connected to. The bearer token itself is never persisted. */
  readonly gatewayUrl: string;
  readonly token: string | null;
  readonly workspaces: ReadonlyArray<TeamWorkspaceAccess> | null;
  readonly workspacesError: string | null;
  readonly currentWorkspaceId: string | null;
  /** Members and artifacts are kept only for the selected workspace. */
  readonly members: ReadonlyArray<TeamMember> | null;
  readonly membersError: string | null;
  readonly artifacts: ReadonlyArray<TeamArtifact> | null;
  readonly artifactsError: string | null;
  readonly artifactsUnavailable: boolean;
  /** Origin of the environment that serves the artifact route; links must not use the page origin. */
  readonly artifactBaseUrl: string | null;
  readonly busy: boolean;

  readonly connect: (gatewayUrl: string, credential: string) => Promise<boolean>;
  readonly disconnect: () => Promise<void>;
  readonly loadWorkspaces: () => Promise<void>;
  readonly selectWorkspace: (workspaceId: string | null) => void;
  readonly loadMembers: () => Promise<void>;
  readonly loadArtifacts: () => Promise<void>;
  readonly invite: (input: {
    name: string;
    role: TeamRole;
  }) => Promise<{ credential: string } | null>;
  readonly setMemberRole: (userId: string, role: TeamRole) => Promise<boolean>;
  readonly removeMember: (userId: string) => Promise<boolean>;
  readonly handleWorkspaceAccessLost: (
    error: unknown,
    area: "members" | "artifacts",
    message: string,
  ) => void;
}

const clearWorkspaceScoped = () => ({
  members: null,
  membersError: null,
  artifacts: null,
  artifactsError: null,
  artifactsUnavailable: false,
});

const clearSession = () => ({
  token: null,
  workspaces: null,
  workspacesError: null,
  currentWorkspaceId: null,
  ...clearWorkspaceScoped(),
});

const connectionOf = (state: Pick<TeamState, "gatewayUrl" | "token">) =>
  state.token === null ? null : { baseUrl: state.gatewayUrl, token: state.token };

export const useTeamStore = create<TeamState>()(
  persist(
    (set, get) => ({
      gatewayUrl: DEFAULT_TEAM_GATEWAY_URL,
      token: null,
      workspaces: null,
      workspacesError: null,
      currentWorkspaceId: null,
      members: null,
      membersError: null,
      artifacts: null,
      artifactsError: null,
      artifactsUnavailable: false,
      artifactBaseUrl: null,
      busy: false,

      connect: async (gatewayUrl, credential) => {
        set({ busy: true, workspacesError: null });
        try {
          const token = await login({ baseUrl: gatewayUrl }, credential.trim());
          set({ gatewayUrl, token, busy: false, workspaces: null, currentWorkspaceId: null });
          await get().loadWorkspaces();
          return get().workspacesError === null;
        } catch (error) {
          set({ ...clearSession(), gatewayUrl, workspacesError: errorMessage(error), busy: false });
          return false;
        }
      },

      disconnect: async () => {
        const connection = connectionOf(get());
        set({ ...clearSession(), busy: false });
        if (connection === null) return;
        try {
          await logout(connection);
        } catch (error) {
          // The local session is already gone; say that the server may still hold it.
          set({ workspacesError: `已断开本地会话，但服务端登出失败：${errorMessage(error)}` });
        }
      },

      loadWorkspaces: async () => {
        const connection = connectionOf(get());
        if (connection === null) return;
        set({ busy: true, workspacesError: null });
        try {
          const workspaces = await listWorkspaces(connection);
          set((state) => {
            const stillMember =
              state.currentWorkspaceId !== null &&
              workspaces.some((workspace) => workspace.id === state.currentWorkspaceId);
            return {
              workspaces,
              busy: false,
              ...(stillMember || state.currentWorkspaceId === null
                ? {}
                : { currentWorkspaceId: null, ...clearWorkspaceScoped() }),
            };
          });
        } catch (error) {
          if (isSessionLost(error)) {
            set({ ...clearSession(), workspacesError: errorMessage(error), busy: false });
            return;
          }
          set({ workspacesError: errorMessage(error), busy: false });
        }
      },

      selectWorkspace: (workspaceId) => {
        set(() => ({
          currentWorkspaceId: workspaceId,
          // Switching drops the old tenant's rows before the new ones arrive.
          ...clearWorkspaceScoped(),
        }));
        if (workspaceId !== null) {
          void get().loadMembers();
          void get().loadArtifacts();
        }
      },

      loadMembers: async () => {
        const state = get();
        const connection = connectionOf(state);
        const workspaceId = state.currentWorkspaceId;
        if (connection === null || workspaceId === null) return;
        set({ membersError: null });
        try {
          const members = await listMembers(connection, workspaceId);
          if (get().currentWorkspaceId === workspaceId) set({ members });
        } catch (error) {
          if (get().currentWorkspaceId !== workspaceId) return;
          get().handleWorkspaceAccessLost(error, "members", errorMessage(error));
        }
      },

      loadArtifacts: async () => {
        const workspaceId = get().currentWorkspaceId;
        if (workspaceId === null) return;
        set({ artifactsError: null, artifactsUnavailable: false });
        try {
          const request = await teamArtifactRequest();
          const artifacts = await listArtifacts({ ...request, workspaceId });
          if (get().currentWorkspaceId === workspaceId) {
            set({ artifacts, artifactBaseUrl: request.baseUrl });
          }
        } catch (error) {
          if (get().currentWorkspaceId !== workspaceId) return;
          // A server without the artifact route cannot serve this workspace's artifacts yet.
          if (isTeamApiError(error) && error.status === 404) {
            set({ artifactsUnavailable: true, artifacts: [] });
            return;
          }
          // The members plane decides who belongs to the workspace; an artifact denial only says
          // this environment cannot serve that member's artifacts, so it must not drop the choice.
          set({ artifactsError: errorMessage(error) });
        }
      },

      invite: async (input) => {
        const state = get();
        const connection = connectionOf(state);
        const workspaceId = state.currentWorkspaceId;
        if (connection === null || workspaceId === null) return null;
        const result = await inviteMember(connection, {
          workspaceId,
          userId: invitedUserId(input.name),
          name: input.name.trim(),
          role: input.role,
        });
        await get().loadMembers();
        return result;
      },

      setMemberRole: async (userId, role) => {
        const state = get();
        const connection = connectionOf(state);
        const workspaceId = state.currentWorkspaceId;
        if (connection === null || workspaceId === null) return false;
        try {
          await setMemberRole(connection, { workspaceId, userId, role });
          if (get().currentWorkspaceId !== workspaceId) return true;
          // The caller's own role may have changed; the Owner controls depend on it.
          await Promise.all([get().loadMembers(), get().loadWorkspaces()]);
          return true;
        } catch (error) {
          if (get().currentWorkspaceId === workspaceId) {
            get().handleWorkspaceAccessLost(error, "members", errorMessage(error));
          }
          return false;
        }
      },

      removeMember: async (userId) => {
        const state = get();
        const connection = connectionOf(state);
        const workspaceId = state.currentWorkspaceId;
        if (connection === null || workspaceId === null) return false;
        try {
          await removeMember(connection, { workspaceId, userId });
          if (get().currentWorkspaceId !== workspaceId) return true;
          await Promise.all([get().loadMembers(), get().loadWorkspaces()]);
          return true;
        } catch (error) {
          if (get().currentWorkspaceId === workspaceId) {
            get().handleWorkspaceAccessLost(error, "members", errorMessage(error));
          }
          return false;
        }
      },

      /**
       * A lost session clears everything; a lost membership clears only that workspace and keeps
       * the token, because the gateway session is still valid for the member's other workspaces.
       */
      handleWorkspaceAccessLost: (error, area, message) => {
        if (isSessionLost(error)) {
          set(() => ({ ...clearSession(), workspacesError: message }));
          return;
        }
        if (isWorkspaceAccessLost(error)) {
          set(() => ({
            currentWorkspaceId: null,
            workspacesError: message,
            ...clearWorkspaceScoped(),
          }));
          return;
        }
        set(area === "members" ? { membersError: message } : { artifactsError: message });
      },
    }),
    {
      name: "t3code:team:v1",
      storage: createJSONStorage(() =>
        typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
      ),
      // A bearer token stays in memory; only the gateway the user chose is kept.
      partialize: (state) => ({ gatewayUrl: state.gatewayUrl }),
    },
  ),
);
