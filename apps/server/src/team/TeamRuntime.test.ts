import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This test uses an actual HTTP server.
import * as NodeHttp from "node:http";
import { TeamError, TeamRpcGroup, type TeamRun } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as TeamControlPlane from "./TeamControlPlane.ts";
import * as TeamRuntime from "./TeamRuntime.ts";

it.live("delivers a run from an open HTTP subscription before that subscription ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const unavailable = () => Effect.fail(new TeamError({ rule: "authentication_required" }));
      const run: TeamRun = {
        id: "team.a.owner.c",
        nativeRunId: "native-c",
        status: "completed",
        output: ["ok"],
      };
      const service = TeamControlPlane.TeamControlPlane.of({
        login: unavailable,
        logout: unavailable,
        workspaces: unavailable,
        workspace: unavailable,
        createWorkspace: unavailable,
        renameWorkspace: unavailable,
        deleteWorkspace: unavailable,
        members: unavailable,
        invite: unavailable,
        setMember: unavailable,
        removeMember: unavailable,
        start: unavailable,
        read: unavailable,
        stream: () => Stream.concat(Stream.succeed(run), Stream.never),
      });
      const context = yield* Layer.build(
        HttpRouter.serve(TeamRuntime.http).pipe(
          Layer.provide(Layer.succeed(TeamControlPlane.TeamControlPlane, service)),
          Layer.provideMerge(
            NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
          ),
        ),
      );
      const address = Context.get(context, HttpServer.HttpServer).address;
      assert.equal(address._tag, "InetAddressV4");
      if (address._tag !== "InetAddressV4")
        return yield* Effect.die(new Error("Expected TCP server"));
      const received = yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(TeamRpcGroup);
        return yield* client["team.stream"]({ workspaceId: "a", runId: run.id }).pipe(
          Stream.take(1),
          Stream.runCollect,
        );
      }).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${address.port}/team/rpc` }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(RpcSerialization.layerNdjson),
          ),
        ),
      );
      assert.deepEqual(received, [run]);
    }),
  ),
);
