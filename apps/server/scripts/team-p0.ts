import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer needs a native server constructor.
import * as NodeHttp from "node:http";
import { TeamRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { RpcServer, RpcSerialization } from "effect/rpc";
import * as TeamControlPlane from "../src/team/TeamControlPlane.ts";

const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(TeamControlPlane.TeamConfig));

const program = Effect.gen(function* () {
  const path = process.argv[2];
  if (!path) return yield* Effect.die(new Error("Usage: node scripts/team-p0.ts CONFIG.json"));
  const fs = yield* FileSystem.FileSystem;
  const config = yield* decodeConfig(yield* fs.readFileString(path));
  const port = yield* Config.Int("TEAM_P0_PORT").pipe(Config.withDefault(3781));
  const server = RpcServer.layerHttp({
    group: TeamRpcGroup,
    path: "/team/rpc",
    protocol: "http",
  }).pipe(
    Layer.provide(TeamControlPlane.handlers),
    Layer.provide(TeamControlPlane.layer(config)),
    Layer.provide(RpcSerialization.layerJson),
  );
  return yield* Layer.launch(
    HttpRouter.serve(server).pipe(
      Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port })),
    ),
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
