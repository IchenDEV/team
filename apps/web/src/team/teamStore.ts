import {
  isMembershipRevocation,
  isTeamApiError,
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
        // The session may already be gone; the local state is what has to be cleared.
        await logout(connection).catch(() => undefined);
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
              // The current workspace may have revoked this member since the last read.
              ...(stillMember || state.currentWorkspaceId === null
                ? {}
                : { currentWorkspaceId: null, ...clearWorkspaceScoped() }),
            };
          });
        } catch (error) {
          if (isMembershipRevocation(error)) {
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
          get().handleWorkspaceAccessLost(error, "members", errorMessage(error));
        }
      },

      loadArtifacts: async () => {
        const workspaceId = get().currentWorkspaceId;
        if (workspaceId === null) return;
        set({ artifactsError: null, artifactsUnavailable: false });
        try {
          const artifacts = await listArtifacts({
            ...(await teamArtifactRequest()),
            workspaceId,
          });
          if (get().currentWorkspaceId === workspaceId) set({ artifacts });
        } catch (error) {
          // A server without the artifact route cannot serve this workspace's artifacts yet.
          if (isTeamApiError(error) && error.status === 404) {
            set({ artifactsUnavailable: true, artifacts: [] });
            return;
          }
          get().handleWorkspaceAccessLost(error, "artifacts", errorMessage(error));
        }
      },

      invite: async (input) => {
        const state = get();
        const connection = connectionOf(state);
        const workspaceId = state.currentWorkspaceId;
        if (connection === null || workspaceId === null) return null;
        // The invited user id is derived from the name so an Owner does not type two fields.
        const userId = `u_${input.name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")}`;
        const result = await inviteMember(connection, {
          workspaceId,
          userId,
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
          await get().loadMembers();
          return true;
        } catch (error) {
          get().handleWorkspaceAccessLost(error, "members", errorMessage(error));
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
          await get().loadMembers();
          return true;
        } catch (error) {
          get().handleWorkspaceAccessLost(error, "members", errorMessage(error));
          return false;
        }
      },

      // A lost session or membership means every workspace-scoped row is no longer authorized.
      handleWorkspaceAccessLost: (error, area, message) => {
        if (isMembershipRevocation(error)) {
          set(() => ({
            ...clearSession(),
            workspacesError: message,
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
