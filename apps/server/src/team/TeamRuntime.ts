import { TeamRpcGroup } from "@t3tools/contracts";
import { RpcServer, RpcSerialization } from "effect/rpc";
import * as Layer from "effect/Layer";
import * as TeamControlPlane from "./TeamControlPlane.ts";
import { layer as boundaryLayer } from "./TeamExecutionBoundary.ts";
import { layer as dockerSandboxLayer } from "./DockerSandbox.ts";
import { layer as processRunnerLayer } from "../processRunner.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

// The environment server already provides EnvironmentAuth, so mounting the control
// plane there uses this layer: a second EnvironmentAuth instance would keep its own
// session invalidation events.
export const layerOnEnvironment = (config: TeamControlPlane.TeamConfig) =>
  TeamControlPlane.layer(config).pipe(
    Layer.provideMerge(
      boundaryLayer({ stateDir: config.sandboxStateDir ?? "" }).pipe(
        Layer.provideMerge(dockerSandboxLayer({}).pipe(Layer.provideMerge(processRunnerLayer))),
      ),
    ),
    Layer.provideMerge(TeamMemberships.layer),
  );

export const layer = (config: TeamControlPlane.TeamConfig) =>
  layerOnEnvironment(config).pipe(Layer.provideMerge(EnvironmentAuth.layerRuntime));

export const http = RpcServer.layerHttp({
  group: TeamRpcGroup,
  path: "/team/rpc",
  protocol: "http",
}).pipe(Layer.provide(TeamControlPlane.handlers), Layer.provide(RpcSerialization.layerNdjson));
