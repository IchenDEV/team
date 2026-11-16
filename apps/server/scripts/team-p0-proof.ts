import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  ORCHESTRATION_V2_WS_METHODS,
  TeamRpcGroup,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as Console from "effect/Console";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { TeamConfig } from "../src/team/TeamControlPlane.ts";

const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(TeamConfig));

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* decodeConfig(yield* fs.readFileString(process.argv[2]!));
  const commandId = process.argv[3]!;
  const alice = config.users.find((user) => user.id === "alice")!;
  const bob = config.users.find((user) => user.id === "bob")!;
  const workspace = config.workspaces.find((entry) => entry.id === "alpha")!;
  const protocol = RpcClient.layerProtocolHttp({ url: "http://127.0.0.1:3781/team/rpc" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerJson),
  );
  const request = Effect.fn("TeamProof.request")(function* (
    user: typeof alice,
    workspaceId: string,
    readId?: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(TeamRpcGroup);
        const options = { headers: { authorization: `Bearer ${user.token}` } };
        return readId === undefined
          ? yield* client["team.start"](
              { workspaceId, commandId, text: "Respond with a harmless replay result." },
              options,
            )
          : yield* client["team.read"]({ workspaceId, runId: readId }, options);
      }).pipe(Effect.provide(protocol)),
    );
  });
  const cross = yield* Effect.flip(request(alice, "beta"));
  if (cross._tag !== "TeamError" || cross.rule !== "workspace_membership_required")
    return yield* Effect.die(cross);
  const viewer = yield* Effect.flip(request(bob, "beta"));
  if (viewer._tag !== "TeamError" || viewer.rule !== "viewer_execution_forbidden")
    return yield* Effect.die(viewer);
  yield* Console.log({ crossWorkspace: cross.rule, viewer: viewer.rule });
  const started = yield* request(alice, "alpha");
  yield* Console.log({ submitted: started });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const native = yield* RpcClient.make(WsRpcGroup);
      yield* native[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId: ThreadId.make(started.id),
      }).pipe(
        Stream.filter((item) =>
          item.kind === "snapshot"
            ? item.projection.runs.some(
                (run) =>
                  run.id === started.nativeRunId &&
                  ["completed", "failed", "cancelled"].includes(run.status),
              )
            : item.kind === "event" &&
              item.event.type === "run.updated" &&
              item.event.payload.id === started.nativeRunId &&
              ["completed", "failed", "cancelled"].includes(item.event.payload.status),
        ),
        Stream.take(1),
        Stream.runDrain,
      );
    }).pipe(
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
  const reconnected = yield* request(alice, "alpha", started.id);
  if (
    reconnected.nativeRunId !== started.nativeRunId ||
    reconnected.status !== "completed" ||
    reconnected.output.length === 0
  ) {
    return yield* Effect.die(new Error("The reconnected run did not complete with output."));
  }
  const replayed = yield* request(alice, "alpha");
  if (replayed.nativeRunId !== started.nativeRunId)
    return yield* Effect.die(new Error("Duplicate command started another run."));
  const deniedRead = yield* Effect.flip(request(bob, "alpha", started.id));
  if (deniedRead._tag !== "TeamError" || deniedRead.rule !== "workspace_membership_required")
    return yield* Effect.die(deniedRead);
  yield* Console.log({
    reconnected,
    duplicateCommandSameRun: true,
    crossWorkspaceRead: deniedRead.rule,
    isolation:
      "UNVERIFIED: loopback processes share the host account; Replay is a provider fixture.",
  });
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
