import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

export const TeamId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));

export class TeamError extends Schema.TaggedError<TeamError>()("TeamError", {
  rule: Schema.Literals([
    "authentication_required",
    "workspace_membership_required",
    "viewer_execution_forbidden",
    "run_not_found",
    "command_conflict",
    "executor_failure",
  ]),
}) {
  override get message(): string {
    return this.rule;
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

export const TeamRpcGroup = RpcGroup.make(
  Rpc.make("team.start", { payload: TeamStartInput, success: TeamRun, error: TeamError }),
  Rpc.make("team.read", { payload: TeamReadInput, success: TeamRun, error: TeamError }),
);
