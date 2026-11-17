import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpRouter } from "effect/http";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as TeamArtifacts from "./TeamArtifacts.ts";
import * as TeamArtifactsHttp from "./TeamArtifactsHttp.ts";

const appEnv = Layer.mergeAll(
  TeamArtifacts.layer.pipe(Layer.provide(TeamMemberships.layer)),
  TeamMemberships.layer,
  EnvironmentAuth.layer,
).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ManagedPolicy.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "team-artifacts-http-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const B64_CONTENT = Buffer.from("route-content").toString("base64");

it.effect("serves authenticated artifact routes with workspace ACLs", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(TeamArtifactsHttp.layer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provideMerge(appEnv), Layer.provideMerge(NodeHttpServer.layerTest)),
    );
    const client = Context.get(services, HttpClient.HttpClient);
    const members = Context.get(services, TeamMemberships.TeamMembershipRepository);
    const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const sessions = Context.get(services, SessionStore.SessionStore);
    const sql = Context.get(services, SqlClient.SqlClient);

    yield* members.inviteUser({ id: "alice", subject: "invited:alice", name: "Alice" });
    yield* members.inviteUser({ id: "bob", subject: "invited:bob", name: "Bob" });
    yield* members.inviteUser({ id: "carol", subject: "invited:carol", name: "Carol" });
    yield* members.inviteUser({ id: "dave", subject: "invited:dave", name: "Dave" });
    yield* members.createWorkspace("invited:alice", {
      id: "a",
      projectId: ProjectId.make("project-a"),
      name: "A",
    });
    yield* members.createWorkspace("invited:bob", {
      id: "b",
      projectId: ProjectId.make("project-b"),
      name: "B",
    });

    const login = Effect.fn("test.cookieLogin")(function* (subject: string) {
      const invitation = yield* auth.createPairingLink({
        subject,
        scopes: ["orchestration:read", "orchestration:operate"],
      });
      const exchange = yield* auth.createBrowserSession(invitation.credential, {
        deviceType: "desktop",
      });
      return `${sessions.cookieName}=${exchange.sessionToken}`;
    });
    const alice = yield* login("invited:alice");
    const bob = yield* login("invited:bob");
    const carol = yield* login("invited:carol");
    const dave = yield* login("invited:dave");
    yield* members.setMember("invited:alice", "a", "bob", "Editor");
    yield* members.setMember("invited:alice", "a", "carol", "Viewer");

    const base = TeamArtifactsHttp.TEAM_ARTIFACTS_ROUTE_PREFIX;
    const ws = (workspace: string) => `${base}/${workspace}/artifacts`;
    const get = (path: string, cookie?: string) =>
      client.execute(
        HttpClientRequest.get(path, {
          headers: cookie === undefined ? {} : { cookie },
        }),
      );
    const post = (path: string, cookie: string | undefined, payload: unknown) =>
      client.execute(
        HttpClientRequest.post(path, {
          headers: {
            "content-type": "application/json",
            ...(cookie === undefined ? {} : { cookie }),
          },
        }).pipe(HttpClientRequest.bodyJsonUnsafe(payload)),
      );

    // Anonymous callers are rejected before any workspace lookup.
    assert.equal((yield* get(ws("a"))).status, 401);
    assert.equal(
      (yield* client.execute(
        HttpClientRequest.post(ws("a")).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name: "x", contentBase64: B64_CONTENT }),
        ),
      )).status,
      401,
    );

    const published = yield* post(ws("a"), alice, {
      name: "report.html",
      mimeType: "text/html",
      visibility: "workspace",
      run: { threadId: "thread-http", ref: "turn-3" },
      sourceUrl: "https://media.example.com/bearer-secret/route",
      contentBase64: B64_CONTENT,
    });
    assert.equal(published.status, 201);
    const artifact = (yield* published.json) as Record<string, unknown>;
    assert.equal(artifact.version, 1);
    assert.equal(artifact.ownerUserId, "alice");
    assert.equal(artifact.workspaceId, "a");
    assert.deepEqual(artifact.run, { threadId: "thread-http", ref: "turn-3" });
    const wire = JSON.stringify(artifact);
    assert.equal(wire.includes("storageKey"), false);
    assert.equal(wire.includes("sourceUrl"), false);
    assert.equal(wire.includes("bearer-secret"), false);
    assert.equal(wire.includes("team-artifacts"), false);
    const artifactId = artifact.id as string;
    const detailPath = `${ws("a")}/${artifactId}`;

    const listAsBob = yield* get(ws("a"), bob);
    assert.equal(listAsBob.status, 200);
    const listed = (yield* listAsBob.json) as { artifacts: ReadonlyArray<{ id: string }> };
    assert.deepEqual(
      listed.artifacts.map((item) => item.id),
      [artifactId],
    );

    for (const cookie of [alice, bob, carol]) {
      assert.equal((yield* get(detailPath, cookie)).status, 200);
      const preview = yield* get(`${detailPath}/preview`, cookie);
      assert.equal(preview.status, 200);
      assert.equal(yield* preview.text, "route-content");
      const download = yield* get(`${detailPath}/download`, cookie);
      assert.equal(download.status, 200);
      assert.equal(download.headers["content-disposition"]?.includes("attachment"), true);
      assert.equal(yield* download.text, "route-content");
    }

    const headResponse = yield* client.execute(
      HttpClientRequest.head(`${detailPath}/download`, {
        headers: { cookie: bob },
      }),
    );
    assert.equal(headResponse.status, 200);

    // Nonmember invited users and foreign workspaces are denied server-side.
    for (const path of [ws("a"), detailPath, `${detailPath}/preview`, `${detailPath}/download`]) {
      assert.equal((yield* get(path, dave)).status, 403);
    }
    assert.equal(
      (yield* post(ws("a"), dave, { name: "x.txt", contentBase64: B64_CONTENT })).status,
      403,
    );
    assert.equal((yield* get(`${ws("b")}/${artifactId}`, alice)).status, 403);
    assert.equal((yield* post(`${detailPath}/acl`, dave, { visibility: "private" })).status, 403);

    // Viewer reads but cannot write; ACL changes are Owner-only.
    assert.equal(
      (yield* post(ws("a"), carol, { name: "x.txt", contentBase64: B64_CONTENT })).status,
      403,
    );
    assert.equal(
      (yield* post(`${ws("a")}/import-dry-run`, carol, { entries: [{ id: "n1" }] })).status,
      403,
    );
    assert.equal((yield* post(`${detailPath}/acl`, carol, { visibility: "private" })).status, 403);
    assert.equal((yield* post(`${detailPath}/acl`, bob, { visibility: "private" })).status, 403);
    const acl = yield* post(`${detailPath}/acl`, alice, { visibility: "private" });
    assert.equal(acl.status, 200);
    const aclBody = (yield* acl.json) as { version: number; visibility: string };
    assert.equal(aclBody.version, 2);
    assert.equal(aclBody.visibility, "private");
    yield* post(`${detailPath}/acl`, alice, { visibility: "workspace" });

    // Private artifacts disappear for other members but stay with the owner.
    const mine = yield* post(ws("a"), alice, {
      name: "private.txt",
      visibility: "private",
      contentBase64: B64_CONTENT,
    });
    assert.equal(mine.status, 201);
    const mineId = ((yield* mine.json) as { id: string }).id;
    assert.equal((yield* get(`${ws("a")}/${mineId}`, alice)).status, 200);
    assert.equal((yield* get(`${ws("a")}/${mineId}`, bob)).status, 404);
    assert.equal((yield* get(`${ws("a")}/${mineId}/download`, bob)).status, 404);
    const bobList = (yield* (yield* get(ws("a"), bob)).json) as {
      artifacts: ReadonlyArray<{ id: string }>;
    };
    assert.equal(
      bobList.artifacts.some((item) => item.id === mineId),
      false,
    );

    // Unknown-owner and null-owner rows stay private forever.
    yield* sql`
      INSERT INTO team_artifacts
        (id, workspace_id, project_id, owner_user_id, name, visibility, version,
         storage_key, size_bytes, mime_type, source_url, run_thread_id, run_ref,
         created_at, updated_at)
      VALUES ('orphan', 'a', 'project-a', 'ghost', 'legacy.bin', 'workspace', 4,
              NULL, 9, NULL, 'https://bearer.example/x', NULL, NULL, 0, 0)
    `;
    for (const cookie of [alice, bob, carol]) {
      assert.equal((yield* get(`${ws("a")}/orphan`, cookie)).status, 404);
      assert.equal((yield* get(`${ws("a")}/orphan/download`, cookie)).status, 404);
    }

    // Dry-run import: plan only, nothing written.
    const plan = yield* post(`${ws("a")}/import-dry-run`, bob, {
      entries: [
        { id: "imp1", name: "one.txt", version: 1, ownerUserId: "alice" },
        { id: artifactId, name: "dup.txt", version: 5 },
        { id: "bad id!", name: "bad" },
      ],
    });
    assert.equal(plan.status, 200);
    const planBody = (yield* plan.json) as {
      received: number;
      wouldCreate: ReadonlyArray<{ id: string; version: number }>;
      conflicts: ReadonlyArray<{ id: string }>;
      invalid: ReadonlyArray<{ reason: string }>;
    };
    assert.equal(planBody.received, 3);
    assert.deepEqual(planBody.wouldCreate, [{ id: "imp1", version: 1 }]);
    assert.equal(planBody.conflicts.length, 1);
    assert.equal(planBody.invalid.length, 1);

    // Removing the membership denies every subsequent path on the next request.
    yield* members.removeMember("invited:alice", "a", "bob");
    for (const path of [ws("a"), detailPath, `${detailPath}/preview`, `${detailPath}/download`]) {
      assert.equal((yield* get(path, bob)).status, 403);
    }
    assert.equal(
      (yield* post(`${ws("a")}/import-dry-run`, bob, { entries: [{ id: "x" }] })).status,
      403,
    );

    // Malformed requests and out-of-shape paths.
    assert.equal(
      (yield* post(ws("a"), alice, { name: "", contentBase64: B64_CONTENT })).status,
      400,
    );
    assert.equal((yield* post(ws("a"), alice, { name: "x.txt" })).status, 400);
    assert.equal((yield* get(`${base}/a/other`)).status, 404);
    assert.equal((yield* get(`${base}/bad id!/artifacts`, alice)).status, 404);
    assert.equal((yield* get(`${ws("a")}/${artifactId}/extra`, alice)).status, 404);
  }).pipe(Effect.provide(NodeServices.layer)),
);
