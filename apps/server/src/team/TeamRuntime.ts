import { TeamRpcGroup } from "@t3tools/contracts";
import { RpcServer, RpcSerialization } from "effect/rpc";
import * as Layer from "effect/Layer";
import * as TeamControlPlane from "./TeamControlPlane.ts";
import { layer as boundaryLayer, workspaceRoot } from "./TeamExecutionBoundary.ts";
import { layer as dockerSandboxLayer } from "./DockerSandbox.ts";
import { layer as processRunnerLayer } from "../processRunner.ts";
import * as TeamHumanCalls from "./TeamHumanCalls.ts";
import * as TeamHumanCallPersistence from "../persistence/TeamHumanCalls.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

// The relay is what turns a run's call files into rows and back, so it lives with
// the gateway that owns memberships and the workspace roots.
const humanCallLayer = (config: TeamControlPlane.TeamConfig) => {
  const stateDir = config.sandboxStateDir ?? "";
  return TeamHumanCalls.layer({
    root: (workspaceId) => workspaceRoot(stateDir, workspaceId),
    workspaceIds: config.workspaces.map((workspace) => workspace.id),
  }).pipe(Layer.provideMerge(TeamHumanCallPersistence.layer));
};

// The environment server already provides EnvironmentAuth, so mounting the control
// plane there uses this layer: a second EnvironmentAuth instance would keep its own
// session invalidation events.
export const layerOnEnvironment = (config: TeamControlPlane.TeamConfig) =>
  Layer.mergeAll(TeamControlPlane.layer(config), TeamHumanCalls.tickLoop).pipe(
    Layer.provideMerge(humanCallLayer(config)),
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
