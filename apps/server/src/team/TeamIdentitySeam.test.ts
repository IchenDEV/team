import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpRouter } from "effect/http";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as TeamArtifacts from "./TeamArtifacts.ts";
import * as TeamArtifactsHttp from "./TeamArtifactsHttp.ts";
import * as TeamControlPlane from "./TeamControlPlane.ts";
import * as TeamRuntime from "./TeamRuntime.ts";

const teamConfig: TeamControlPlane.TeamConfig = {
  workspaces: [
    {
      id: "alpha",
      projectId: ProjectId.make("alpha"),
      modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "todo-list" },
    },
  ],
};

const appEnv = TeamRuntime.layer(teamConfig).pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ManagedPolicy.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "team-identity-seam-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const surface = HttpRouter.serve(TeamArtifactsHttp.layer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provide(TeamArtifacts.layer.pipe(Layer.provide(TeamMemberships.layer))),
  Layer.provideMerge(appEnv),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

const content = Buffer.from("seam-content").toString("base64");

// The member's one team login must be the only credential either surface needs.
it.effect("one team login token serves both the membership and artifact surfaces", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(surface);
      return yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const members = yield* TeamMemberships.TeamMembershipRepository;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const team = yield* TeamControlPlane.TeamControlPlane;

        const ownerSubject = TeamControlPlane.userSubject("owner");
        yield* members.inviteUser({ id: "owner", subject: ownerSubject, name: "Owner" });
        yield* members.createWorkspace(ownerSubject, {
          id: "alpha",
          projectId: ProjectId.make("alpha"),
          name: "Alpha",
        });
        const ownerLink = yield* auth.createPairingLink({
          subject: ownerSubject,
          scopes: ["orchestration:read"],
        });
        const ownerLogin = yield* team.login(ownerLink.credential);
        assert.equal(ownerLogin.scope.includes("orchestration:operate"), false);
        const ownerToken = ownerLogin.access_token;
        const ownerAuth = `Bearer ${ownerToken}`;

        assert.deepEqual(
          (yield* team.workspaces(ownerAuth)).map((entry) => entry.id),
          ["alpha"],
        );

        const artifacts = `${TeamArtifactsHttp.TEAM_ARTIFACTS_ROUTE_PREFIX}/alpha/artifacts`;
        const publish = yield* client.execute(
          HttpClientRequest.post(artifacts, {
            headers: { authorization: ownerAuth, "content-type": "application/json" },
          }).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              name: "report.txt",
              mimeType: "text/plain",
              contentBase64: content,
            }),
          ),
        );
        assert.equal(publish.status, 201);

        const listed = yield* client.execute(
          HttpClientRequest.get(artifacts, { headers: { authorization: ownerAuth } }),
        );
        assert.equal(listed.status, 200);
        const body = (yield* listed.json) as { artifacts: ReadonlyArray<{ id: string }> };
        assert.equal(body.artifacts.length, 1);

        const anonymous = yield* client.execute(HttpClientRequest.get(artifacts));
        assert.equal(anonymous.status, 401);

        // A Viewer's credential is minted read-only, so the same route refuses its write.
        const invitation = yield* team.invite(ownerAuth, {
          workspaceId: "alpha",
          userId: "viewer",
          name: "Viewer",
          role: "Viewer",
        });
        const viewerToken = (yield* team.login(invitation.credential)).access_token;
        const viewerPublish = yield* client.execute(
          HttpClientRequest.post(artifacts, {
            headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
          }).pipe(HttpClientRequest.bodyJsonUnsafe({ name: "x.txt", contentBase64: content })),
        );
        assert.equal(viewerPublish.status, 403);

        return yield* Effect.void;
      }).pipe(Effect.provide(services));
    }),
  ),
);
