import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";
import { ProjectId } from "./baseSchemas.ts";
import { AuthAccessTokenResult } from "./auth.ts";

export const TeamId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
export const TeamName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const TeamRole = Schema.Literals(["Owner", "Editor", "Viewer"]);
export const TeamWorkspace = Schema.Struct({ id: TeamId, projectId: ProjectId, name: TeamName });
export const TeamWorkspaceAccess = Schema.Struct({
  ...TeamWorkspace.fields,
  userId: TeamId,
  role: TeamRole,
});
export const TeamMember = Schema.Struct({ userId: TeamId, name: TeamName, role: TeamRole });

export const TeamErrorRule = Schema.Literals([
  "authentication_required",
  "workspace_membership_required",
  "viewer_execution_forbidden",
  "run_not_found",
  "command_conflict",
  "executor_failure",
  "storage_failure",
  "invited_user_required",
  "user_already_invited",
  "owner_required",
  "last_owner_required",
  "member_not_found",
  "workspace_not_configured",
  "workspace_identifier_reserved",
]);
export type TeamErrorRule = typeof TeamErrorRule.Type;

// Client-side copy for codes whose remedy the bare code cannot carry. Every other
// code is already a descriptive identifier, so it stays as it is.
const teamErrorGuidance: Readonly<Partial<Record<TeamErrorRule, string>>> = {
  workspace_identifier_reserved:
    "This workspace identifier or project binding is reserved: it belongs to a deleted workspace, or to one that already exists, and cannot be reused. Create the workspace under a new identifier and project binding from the server configuration.",
};

export const teamErrorMessage = (rule: TeamErrorRule): string => teamErrorGuidance[rule] ?? rule;

export class TeamError extends Schema.TaggedError<TeamError>()("TeamError", {
  rule: TeamErrorRule,
}) {
  // Clients render the message; `rule` stays the machine-readable code they branch on.
  override get message(): string {
    return teamErrorMessage(this.rule);
  }
}

export const TeamStartInput = Schema.Struct({
  workspaceId: TeamId,
  commandId: TeamId,
  text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(16_384)),
});
export type TeamStartInput = typeof TeamStartInput.Type;
export const TeamReadInput = Schema.Struct({
  workspaceId: TeamId,
  runId: Schema.String.check(Schema.isMaxLength(256)),
});
export type TeamReadInput = typeof TeamReadInput.Type;
export const TeamRun = Schema.Struct({
  id: Schema.String,
  nativeRunId: Schema.String,
  status: OrchestrationV2RunStatus,
  output: Schema.Array(Schema.String),
});
export type TeamRun = typeof TeamRun.Type;

const workspaceInput = Schema.Struct({ workspaceId: TeamId });
const memberInput = Schema.Struct({ workspaceId: TeamId, userId: TeamId });
export const TeamRpcGroup = RpcGroup.make(
  Rpc.make("team.login", {
    payload: { credential: Schema.String },
    success: AuthAccessTokenResult,
    error: TeamError,
  }),
  Rpc.make("team.logout", { success: Schema.Void, error: TeamError }),
  Rpc.make("team.workspaces", { success: Schema.Array(TeamWorkspaceAccess), error: TeamError }),
  Rpc.make("team.workspace", {
    payload: workspaceInput,
    success: TeamWorkspaceAccess,
    error: TeamError,
  }),
  Rpc.make("team.createWorkspace", {
    payload: { workspaceId: TeamId, name: TeamName },
    success: Schema.Void,
    error: TeamError,
  }),
  Rpc.make("team.renameWorkspace", {
    payload: { workspaceId: TeamId, name: TeamName },
    success: Schema.Void,
    error: TeamError,
  }),
  Rpc.make("team.deleteWorkspace", {
    payload: workspaceInput,
    success: Schema.Void,
    error: TeamError,
  }),
  Rpc.make("team.members", {
    payload: workspaceInput,
    success: Schema.Array(TeamMember),
    error: TeamError,
  }),
  Rpc.make("team.invite", {
    payload: { workspaceId: TeamId, userId: TeamId, name: TeamName, role: TeamRole },
    success: Schema.Struct({ credential: Schema.String }),
    error: TeamError,
  }),
  Rpc.make("team.setMember", {
    payload: { ...memberInput.fields, role: TeamRole },
    success: Schema.Void,
    error: TeamError,
  }),
  Rpc.make("team.removeMember", { payload: memberInput, success: Schema.Void, error: TeamError }),
  Rpc.make("team.start", { payload: TeamStartInput, success: TeamRun, error: TeamError }),
  Rpc.make("team.read", { payload: TeamReadInput, success: TeamRun, error: TeamError }),
  Rpc.make("team.stream", {
    payload: TeamReadInput,
    success: TeamRun,
    error: TeamError,
    stream: true,
  }),
);
