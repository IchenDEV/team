import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NetService from "@t3tools/shared/Net";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The proof starts a real HTTP server.
import * as NodeHttp from "node:http";
import { TeamError, TeamRpcGroup } from "@t3tools/contracts";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

import * as TeamControlPlane from "../src/team/TeamControlPlane.ts";
import * as TeamRuntime from "../src/team/TeamRuntime.ts";
import * as TeamMemberships from "../src/persistence/TeamMemberships.ts";
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as TeamArtifacts from "../src/team/TeamArtifacts.ts";
import * as TeamArtifactsHttp from "../src/team/TeamArtifactsHttp.ts";
import * as ServerConfig from "../src/config.ts";
import { resolveCliAuthConfig } from "../src/cli/config.ts";

const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(TeamControlPlane.TeamConfig));
const isTeamError = Schema.is(TeamError);

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const program = Effect.gen(function* () {
  const [configPath, home, commandId] = process.argv.slice(2);
  check(
    Boolean(configPath && home && commandId),
    "Usage: team-identity-proof.ts CONFIG.json ENVIRONMENT_HOME UNIQUE_COMMAND_ID",
  );
  const fs = yield* FileSystem.FileSystem;
  const config = yield* decodeConfig(yield* fs.readFileString(configPath!));
  check(config.workspaces.length >= 2, "The proof needs two configured workspaces.");
  const [alpha, beta] = config.workspaces;
  const serverConfig = yield* resolveCliAuthConfig(
    { baseDir: Option.some(home!) },
    Option.some("Error"),
  );
  check(
    !(yield* fs.exists(serverConfig.dbPath)),
    "The proof needs a fresh environment home; keep earlier evidence.",
  );

  const router = HttpRouter.serve(
    Layer.mergeAll(
      TeamRuntime.http,
      TeamArtifactsHttp.layer.pipe(
        Layer.provide(TeamArtifacts.layer.pipe(Layer.provide(TeamMemberships.layer))),
      ),
    ),
  ).pipe(
    Layer.provideMerge(TeamRuntime.layer(config)),
    Layer.provideMerge(ServerConfig.layer(serverConfig)),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
  );

  // One environment surface serves both the membership RPC and the artifact routes.
  const withSurface = Effect.fn("TeamIdentityProof.withSurface")(function* <A, E>(
    use: (surface: {
      readonly base: string;
      readonly members: TeamMemberships.TeamMembershipRepository["Service"];
      readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
      readonly team: RpcClient.RpcClient<RpcGroup.Rpcs<typeof TeamRpcGroup>, RpcClientError>;
      readonly client: HttpClient.HttpClient;
    }) => Effect.Effect<A, E>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(router);
        const address = Context.get(services, HttpServer.HttpServer).address;
        check(address._tag === "InetAddressV4", "Expected a TCP listener");
        const base = `http://127.0.0.1:${address.port}`;
        const team = yield* RpcClient.make(TeamRpcGroup).pipe(
          Effect.provide(
            RpcClient.layerProtocolHttp({ url: `${base}/team/rpc` }).pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(RpcSerialization.layerNdjson),
            ),
          ),
        );
        const client = Context.get(services, HttpClient.HttpClient);
        return yield* use({
          base,
          members: Context.get(services, TeamMemberships.TeamMembershipRepository),
          auth: Context.get(services, EnvironmentAuth.EnvironmentAuth),
          team,
          client,
        });
      }),
    );
  });

  const artifactsPath = (workspaceId: string) =>
    `${TeamArtifactsHttp.TEAM_ARTIFACTS_ROUTE_PREFIX}/${workspaceId}/artifacts`;
  const contentBase64 = Buffer.from(`artifact-${commandId}`).toString("base64");

  const first = yield* withSurface(({ base, members, auth, team, client }) =>
    Effect.gen(function* () {
      // Bootstrap runs against the same store the surface serves, in the way the
      // operator's one-shot script does before the environment server starts.
      const ownerSubject = TeamControlPlane.userSubject("owner");
      yield* members.inviteUser({ id: "owner", subject: ownerSubject, name: "Owner" });
      yield* members.createWorkspace(ownerSubject, {
        id: alpha!.id,
        projectId: alpha!.projectId,
        name: "Alpha",
      });
      const ownerLink = yield* auth.createPairingLink({
        subject: ownerSubject,
        scopes: ["orchestration:read", "orchestration:operate"],
      });

      const ownerToken = yield* team["team.login"]({ credential: ownerLink.credential });
      const owner = { headers: { authorization: `Bearer ${ownerToken.access_token}` } };
      const workspaceIds = (yield* team["team.workspaces"](undefined, owner))
        .map((entry) => entry.id)
        .join();
      check(workspaceIds === alpha!.id, `Owner listed ${workspaceIds}`);

      // The same bearer serves the artifact surface: no cookie, no second login.
      const published = yield* client.execute(
        HttpClientRequest.post(`${base}${artifactsPath(alpha!.id)}`, {
          headers: { ...owner.headers, "content-type": "application/json" },
        }).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            name: "report.txt",
            mimeType: "text/plain",
            contentBase64,
          }),
        ),
      );
      check(published.status === 201, `Artifact publish returned ${published.status}`);

      const listed = yield* client.execute(
        HttpClientRequest.get(`${base}${artifactsPath(alpha!.id)}`, { headers: owner.headers }),
      );
      check(listed.status === 200, `Artifact list returned ${listed.status}`);
      const body = (yield* listed.json) as {
        artifacts: ReadonlyArray<{ id: string; name: string; previewPath: string }>;
      };
      check(body.artifacts.length === 1, "Artifact list did not contain the published file");
      const artifact = body.artifacts[0]!;
      const preview = yield* client.execute(
        HttpClientRequest.get(`${base}${artifact.previewPath}`, { headers: owner.headers }),
      );
      check(preview.status === 200, `Artifact preview returned ${preview.status}`);
      const text = yield* preview.text;
      check(text === `artifact-${commandId}`, "Artifact content changed in transit");

      const anonymous = yield* client.execute(
        HttpClientRequest.get(`${base}${artifactsPath(alpha!.id)}`),
      );
      check(anonymous.status === 401, "The artifact route answered without a session");

      // A Viewer's credential is minted read-only; the same route refuses its write.
      const viewerInvite = yield* team["team.invite"](
        { workspaceId: alpha!.id, userId: "viewer", name: "Viewer", role: "Viewer" },
        owner,
      );
      const viewerToken = yield* team["team.login"](viewerInvite);
      const viewerWrite = yield* client.execute(
        HttpClientRequest.post(`${base}${artifactsPath(alpha!.id)}`, {
          headers: { authorization: `Bearer ${viewerToken.access_token}` },
        }).pipe(HttpClientRequest.bodyJsonUnsafe({ name: "x.txt", contentBase64 })),
      );
      check(viewerWrite.status === 403, `Viewer write returned ${viewerWrite.status}`);

      // Cross-workspace reads stay denied on the membership surface.
      const crossWorkspace = yield* team["team.workspace"]({ workspaceId: beta!.id }, owner).pipe(
        Effect.flip,
      );
      check(
        isTeamError(crossWorkspace) && crossWorkspace.rule === "workspace_membership_required",
        "A non-member workspace answered",
      );

      // The one-time credential is consumed; a replay must not mint another session.
      const replay = yield* team["team.login"]({ credential: ownerLink.credential }).pipe(
        Effect.flip,
      );
      check(isTeamError(replay) && replay.rule === "authentication_required", "Login replay");

      return { owner, artifactId: artifact.id, ownerToken: ownerToken.access_token };
    }),
  );

  // Restart: a second surface over the same home must accept the same session and
  // still resolve the same artifact, so identity and data are durable, not in-memory.
  yield* withSurface(({ base, client }) =>
    Effect.gen(function* () {
      const headers = { authorization: `Bearer ${first.ownerToken}` };
      const listed = yield* client.execute(
        HttpClientRequest.get(`${base}${artifactsPath(alpha!.id)}`, { headers }),
      );
      check(listed.status === 200, `Restart artifact list returned ${listed.status}`);
      const body = (yield* listed.json) as { artifacts: ReadonlyArray<{ id: string }> };
      check(
        body.artifacts.some((entry) => entry.id === first.artifactId),
        "Restart lost the artifact",
      );
    }),
  );

  yield* Console.log({
    surface: "one environment process",
    login: "PASS",
    membershipSurface: "PASS",
    artifactSurfaceWithSameToken: "PASS",
    anonymousArtifactRead: "401",
    viewerArtifactWrite: "403",
    crossWorkspace: "workspace_membership_required",
    credentialReplay: "authentication_required",
    restartPersistence: "PASS",
    artifactId: first.artifactId,
    commandId,
  });
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
  ),
);
