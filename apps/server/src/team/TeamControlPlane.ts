import {
  CommandId,
  MessageId,
  ModelSelection,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  TeamError,
  TeamId,
  TeamRpcGroup,
  ThreadId,
  WsRpcGroup,
  type TeamReadInput,
  type TeamRun,
  type TeamStartInput,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { RpcClientError } from "effect/rpc/RpcClientError";

const Workspace = Schema.Struct({
  id: TeamId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  rpcUrl: Schema.String,
  bearer: Schema.String.check(Schema.isMinLength(32)),
});

export const TeamConfig = Schema.Struct({
  users: Schema.Array(
    Schema.Struct({ id: TeamId, token: Schema.String.check(Schema.isMinLength(32)) }),
  ),
  memberships: Schema.Array(
    Schema.Struct({
      userId: TeamId,
      workspaceId: TeamId,
      role: Schema.Literals(["Owner", "Editor", "Viewer"]),
    }),
  ),
  workspaces: Schema.Array(Workspace),
});
export type TeamConfig = typeof TeamConfig.Type;

class TeamExecutorFailure extends Schema.TaggedError<TeamExecutorFailure>()("TeamExecutorFailure", {
  cause: Schema.Defect(),
}) {}

export class TeamControlPlane extends Context.Service<
  TeamControlPlane,
  {
    readonly start: (
      authorization: string | undefined,
      input: TeamStartInput,
    ) => Effect.Effect<TeamRun, TeamError | TeamExecutorFailure>;
    readonly read: (
      authorization: string | undefined,
      input: TeamReadInput,
    ) => Effect.Effect<TeamRun, TeamError | TeamExecutorFailure>;
  }
>()("t3/team/TeamControlPlane") {}

const withClient = Effect.fn("TeamControlPlane.withClient")(
  function* <A, E>(
    workspace: typeof Workspace.Type,
    use: (
      client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof WsRpcGroup>, RpcClientError>,
    ) => Effect.Effect<A, E>,
  ) {
    return yield* Effect.scoped(
      Effect.flatMap(RpcClient.make(WsRpcGroup), use).pipe(
        Effect.provide(
          RpcClient.layerProtocolSocket({
            retryTransientErrors: false,
            retryPolicy: Schedule.recurs(0),
          }).pipe(
            Layer.provide(
              NodeSocket.layerWebSocket(workspace.rpcUrl, {
                headers: { authorization: `Bearer ${workspace.bearer}` },
              }),
            ),
            Layer.provide(RpcSerialization.layerJson),
          ),
        ),
      ),
    );
  },
  Effect.tapError((cause) => Effect.logError("Team executor request failed", { cause })),
  Effect.mapError((cause) => new TeamExecutorFailure({ cause })),
);

export const layer = (config: TeamConfig) =>
  Layer.sync(TeamControlPlane, () => {
    const authorize = Effect.fn("TeamControlPlane.authorize")(function* (
      authorization: string | undefined,
      workspaceId: string,
      execute: boolean,
    ) {
      const user = config.users.find((candidate) => authorization === `Bearer ${candidate.token}`);
      if (!user) return yield* new TeamError({ rule: "authentication_required" });
      const membership = config.memberships.find(
        (candidate) => candidate.userId === user.id && candidate.workspaceId === workspaceId,
      );
      const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!membership || !workspace)
        return yield* new TeamError({ rule: "workspace_membership_required" });
      if (execute && membership.role === "Viewer")
        return yield* new TeamError({ rule: "viewer_execution_forbidden" });
      return { user, workspace };
    });

    const readRun = Effect.fn("TeamControlPlane.readRun")(function* (
      workspace: typeof Workspace.Type,
      id: string,
    ) {
      if (
        !new RegExp(`^team\\.${workspace.id}\\.[A-Za-z0-9_-]{1,64}\\.[A-Za-z0-9_-]{1,64}$`).test(id)
      ) {
        return yield* new TeamError({ rule: "run_not_found" });
      }
      const projection = yield* withClient(workspace, (client) =>
        client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: ThreadId.make(id) }),
      );
      if (projection.thread.projectId !== workspace.projectId || projection.runs.length !== 1) {
        return yield* new TeamError({ rule: "run_not_found" });
      }
      const run = projection.runs[0]!;
      return {
        id,
        nativeRunId: run.id,
        status: run.status,
        output: projection.messages
          .filter((message) => message.runId === run.id && message.role === "assistant")
          .map((message) => message.text),
      };
    });

    return TeamControlPlane.of({
      start: Effect.fn("TeamControlPlane.start")(function* (authorization, input) {
        const { user, workspace } = yield* authorize(authorization, input.workspaceId, true);
        const id = `team.${workspace.id}.${user.id}.${input.commandId}`;
        const result = yield* withClient(workspace, (client) =>
          client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
            commandId: CommandId.make(id),
            threadId: ThreadId.make(id),
            projectId: workspace.projectId,
            title: "Team execution",
            generateTitle: false,
            modelSelection: workspace.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId: MessageId.make(id), text: input.text, attachments: [] },
          }),
        );
        const original = result.projection.messages.find((message) => message.id === id);
        if (!original || original.text !== input.text)
          return yield* new TeamError({ rule: "command_conflict" });
        return yield* readRun(workspace, id);
      }),
      read: Effect.fn("TeamControlPlane.read")(function* (authorization, input) {
        const { workspace } = yield* authorize(authorization, input.workspaceId, false);
        return yield* readRun(workspace, input.runId);
      }),
    });
  });

export const handlers = TeamRpcGroup.toLayer(
  Effect.gen(function* () {
    const team = yield* TeamControlPlane;
    return {
      "team.start": (input, { headers }) =>
        team.start(headers.authorization, input).pipe(
          Effect.catchTags({
            TeamExecutorFailure: () => Effect.fail(new TeamError({ rule: "executor_failure" })),
          }),
        ),
      "team.read": (input, { headers }) =>
        team.read(headers.authorization, input).pipe(
          Effect.catchTags({
            TeamExecutorFailure: () => Effect.fail(new TeamError({ rule: "executor_failure" })),
          }),
        ),
    };
  }),
);
