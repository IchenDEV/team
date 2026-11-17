import { TeamRpcGroup } from "@t3tools/contracts";
import { RpcServer, RpcSerialization } from "effect/rpc";
import * as Layer from "effect/Layer";
import * as TeamControlPlane from "./TeamControlPlane.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

export const layer = (config: TeamControlPlane.TeamConfig) =>
  TeamControlPlane.layer(config).pipe(
    Layer.provideMerge(TeamMemberships.layer),
    Layer.provideMerge(EnvironmentAuth.layerRuntime),
  );

export const http = RpcServer.layerHttp({
  group: TeamRpcGroup,
  path: "/team/rpc",
  protocol: "http",
}).pipe(Layer.provide(TeamControlPlane.handlers), Layer.provide(RpcSerialization.layerNdjson));
