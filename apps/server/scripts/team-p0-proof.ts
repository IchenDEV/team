import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NetService from "@t3tools/shared/Net";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The proof starts a real HTTP server.
import * as NodeHttp from "node:http";
import { CommandId, WS_METHODS, TeamError, TeamRpcGroup, WsRpcGroup } from "@t3tools/contracts";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as TeamControlPlane from "../src/team/TeamControlPlane.ts";
import * as TeamRuntime from "../src/team/TeamRuntime.ts";
import * as TeamMemberships from "../src/persistence/TeamMemberships.ts";
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServerConfig from "../src/config.ts";
import { resolveCliAuthConfig } from "../src/cli/config.ts";

const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(TeamControlPlane.TeamConfig));
const isTeamError = Schema.is(TeamError);
function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function denied(error: unknown, expected: string) {
  check(isTeamError(error) && error.rule === expected, `Expected ${expected}`);
}
const program = Effect.gen(function* () {
  const [configPath, home, commandId] = process.argv.slice(2);
  check(
    Boolean(configPath && home && commandId),
    "Usage: team-p0-proof.ts SYNTHETIC_CONFIG.json NEW_ISOLATED_HOME UNIQUE_COMMAND_ID",
  );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* decodeConfig(yield* fs.readFileString(configPath!));
  check(
    config.workspaces.length >= 3,
    "Proof needs alpha, beta and gamma configured with distinct native projects.",
  );
  const serverConfig = yield* resolveCliAuthConfig(
    { baseDir: Option.some(home!) },
    Option.some("Error"),
  );
  check(
    !(yield* fs.exists(serverConfig.dbPath)),
    "Proof requires a fresh isolated gateway database; retain previous evidence.",
  );
  const first = config.workspaces[0]!;
  const nativeProtocol = RpcClient.layerProtocolSocket({
    retryTransientErrors: false,
    retryPolicy: Schedule.recurs(0),
  }).pipe(
    Layer.provide(
      NodeSocket.layerWebSocket(first.rpcUrl, {
        headers: { authorization: `Bearer ${first.bearer}` },
      }),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const native = yield* RpcClient.make(WsRpcGroup);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const workspace of config.workspaces) {
        const root = path.join(path.dirname(configPath!), "native-projects", workspace.projectId);
        yield* fs.makeDirectory(root, { recursive: true });
        const git = yield* spawner.spawn(ChildProcess.make("git", ["init", "--quiet", root]));
        check((yield* git.exitCode) === 0, "Synthetic project Git initialization failed");
        yield* native[WS_METHODS.projectsMutate]({
          type: "project.create",
          commandId: CommandId.make(`proof-setup-${workspace.projectId}`),
          projectId: workspace.projectId,
          title: workspace.id,
          workspaceRoot: root,
          createWorkspaceRootIfMissing: true,
        });
      }
    }).pipe(Effect.provide(nativeProtocol)),
  );

  const gateway = HttpRouter.serve(TeamRuntime.http).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(
      TeamRuntime.layer(config).pipe(Layer.provideMerge(ServerConfig.layer(serverConfig))),
    ),
  );
  const withGateway = Effect.fn("TeamProof.withGateway")(function* <A, E, R>(
    use: (url: string) => Effect.Effect<A, E, R>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(gateway);
        const address = Context.get(context, HttpServer.HttpServer).address;
        check(address._tag === "InetAddressV4", "Expected TCP server");
        return yield* use(`http://127.0.0.1:${address.port}/team/rpc`).pipe(
          Effect.provide(context),
        );
      }),
    );
  });
  const withClient = Effect.fn("TeamProof.withClient")(function* <A, E, R>(
    url: string,
    use: (
      client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof TeamRpcGroup>, RpcClientError>,
    ) => Effect.Effect<A, E, R>,
  ) {
    return yield* Effect.scoped(
      Effect.flatMap(RpcClient.make(TeamRpcGroup), use).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(RpcSerialization.layerNdjson),
          ),
        ),
      ),
    );
  });

  const persisted = yield* withGateway((url) =>
    Effect.gen(function* () {
      const members = yield* TeamMemberships.TeamMembershipRepository;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      yield* members.inviteUser({
        id: "owner",
        subject: TeamControlPlane.userSubject("owner"),
        name: "Synthetic owner",
      });
      yield* members.createWorkspace(TeamControlPlane.userSubject("owner"), {
        id: first.id,
        projectId: first.projectId,
        name: "Alpha",
      });
      const ownerInvite = yield* auth.createPairingLink({
        subject: TeamControlPlane.userSubject("owner"),
        scopes: ["orchestration:read"],
      });
      return yield* withClient(url, (client) =>
        Effect.gen(function* () {
          const ownerToken = yield* client["team.login"]({ credential: ownerInvite.credential });
          const owner = { headers: { authorization: `Bearer ${ownerToken.access_token}` } };
          yield* client["team.createWorkspace"]({ workspaceId: "beta", name: "Beta" }, owner);
          yield* client["team.createWorkspace"]({ workspaceId: "gamma", name: "Temporary" }, owner);
          yield* client["team.renameWorkspace"]({ workspaceId: "gamma", name: "Renamed" }, owner);
          check(
            (yield* client["team.workspace"]({ workspaceId: "gamma" }, owner)).name === "Renamed",
            "Rename lost",
          );
          yield* client["team.deleteWorkspace"]({ workspaceId: "gamma" }, owner);
          const invitation = yield* client["team.invite"](
            { workspaceId: "beta", userId: "bob", name: "Synthetic Bob", role: "Viewer" },
            owner,
          );
          const bobToken = yield* client["team.login"](invitation);
          const bob = { headers: { authorization: `Bearer ${bobToken.access_token}` } };
          denied(
            yield* client["team.login"](invitation).pipe(Effect.flip),
            "authentication_required",
          );
          check(
            (yield* client["team.workspaces"](undefined, bob)).map((w) => w.id).join() === "beta",
            "Cross-workspace list leak",
          );
          const readInput = { workspaceId: "alpha", runId: `team.alpha.owner.${commandId}` };
          for (const operation of [
            client["team.workspace"]({ workspaceId: "alpha" }, bob),
            client["team.members"]({ workspaceId: "alpha" }, bob),
            client["team.renameWorkspace"]({ workspaceId: "alpha", name: "stolen" }, bob),
            client["team.read"](readInput, bob),
            client["team.stream"](readInput, bob).pipe(Stream.runHead),
          ])
            denied(yield* operation.pipe(Effect.flip), "workspace_membership_required");
          denied(
            yield* client["team.start"](
              { workspaceId: "beta", commandId: "denied", text: "no run" },
              bob,
            ).pipe(Effect.flip),
            "viewer_execution_forbidden",
          );
          denied(
            yield* client["team.setMember"](
              { workspaceId: "beta", userId: "bob", role: "Owner" },
              bob,
            ).pipe(Effect.flip),
            "owner_required",
          );
          const startInput = {
            workspaceId: "alpha",
            commandId: commandId!,
            text: "Respond with the harmless replay result.",
          };
          const started = yield* client["team.start"](startInput, owner);
          const completed = yield* client["team.stream"](
            { ...readInput, runId: started.id },
            owner,
          ).pipe(
            Stream.filter((run) => run.status === "completed"),
            Stream.take(1),
            Stream.runHead,
          );
          check(
            Option.isSome(completed) && completed.value.output.length > 0,
            "Replay did not complete with output",
          );
          yield* client["team.setMember"](
            { workspaceId: "alpha", userId: "bob", role: "Editor" },
            owner,
          );
          const editorRun = yield* client["team.start"](
            { ...startInput, commandId: `${commandId}-editor` },
            bob,
          );
          check(
            editorRun.id === `team.alpha.bob.${commandId}-editor`,
            "Editor could not start permitted work",
          );
          const observe = Effect.fn("TeamProof.observeRevocation")(function* (
            revoke: Effect.Effect<void, TeamError | RpcClientError>,
          ) {
            const ready = yield* Deferred.make<void>();
            const stopped = yield* Deferred.make<string>();
            yield* client["team.stream"]({ workspaceId: "alpha", runId: started.id }, bob).pipe(
              Stream.tap(() => Deferred.succeed(ready, undefined)),
              Stream.runDrain,
              Effect.matchEffect({
                onFailure: (error) =>
                  Deferred.succeed(stopped, isTeamError(error) ? error.rule : error._tag),
                onSuccess: () => Deferred.succeed(stopped, "unexpected_completion"),
              }),
              Effect.forkScoped,
            );
            yield* Deferred.await(ready);
            yield* revoke;
            return yield* Deferred.await(stopped);
          });
          check(
            (yield* observe(
              client["team.removeMember"]({ workspaceId: "alpha", userId: "bob" }, owner),
            )) === "workspace_membership_required",
            "Revocation did not cut an idle subscription",
          );
          denied(
            yield* client["team.read"]({ workspaceId: "alpha", runId: started.id }, bob).pipe(
              Effect.flip,
            ),
            "workspace_membership_required",
          );
          yield* client["team.setMember"](
            { workspaceId: "alpha", userId: "bob", role: "Viewer" },
            owner,
          );
          check(
            (yield* observe(client["team.logout"](undefined, bob))) === "authentication_required",
            "Logout did not cut an idle subscription",
          );
          denied(
            yield* client["team.workspaces"](undefined, bob).pipe(Effect.flip),
            "authentication_required",
          );
          yield* client["team.removeMember"]({ workspaceId: "alpha", userId: "bob" }, owner);
          yield* Console.log({
            httpRpc: "PASS",
            workspaceCrud: "PASS",
            twoIdentities: "PASS",
            crossWorkspace: "PASS",
            viewerAndOwnerGuards: "PASS",
            editorExecution: "PASS",
            membershipRevocationAndLogoutStreams: "PASS",
            runId: started.id,
            nativeRunId: started.nativeRunId,
          });
          return { owner, bob, started, startInput };
        }),
      );
    }),
  );
  yield* withGateway((url) =>
    withClient(url, (client) =>
      Effect.gen(function* () {
        const read = yield* client["team.read"](
          { workspaceId: "alpha", runId: persisted.started.id },
          persisted.owner,
        );
        const duplicate = yield* client["team.start"](persisted.startInput, persisted.owner);
        check(
          read.nativeRunId === persisted.started.nativeRunId &&
            read.output.length > 0 &&
            duplicate.nativeRunId === read.nativeRunId,
          "Restart/reconnect changed the native run reference",
        );
        check(
          (yield* client["team.workspaces"](undefined, persisted.owner)).length === 2,
          "Workspace persistence failed",
        );
        const members = yield* client["team.members"]({ workspaceId: "alpha" }, persisted.owner);
        check(!members.some((entry) => entry.userId === "bob"), "Revocation did not persist");
        denied(
          yield* client["team.workspaces"](undefined, persisted.bob).pipe(Effect.flip),
          "authentication_required",
        );
        yield* Console.log({
          gatewayCloseReopen: "PASS",
          persistedSessionAndMemberships: "PASS",
          reconnectAndDuplicateSameNativeRun: "PASS",
          nativeRunId: read.nativeRunId,
          isolation:
            "UNVERIFIED: shared host account; Replay is a provider fixture, HTTP/RPC/SQLite/auth are real.",
        });
      }),
    ),
  );
});
NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
  ),
);
