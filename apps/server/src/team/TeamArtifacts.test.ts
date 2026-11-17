import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as TeamArtifacts from "./TeamArtifacts.ts";

// layerMemory applies every registered migration, including TeamMemberships and TeamArtifacts.
const storeLayer = TeamArtifacts.layer.pipe(
  Layer.provideMerge(TeamMemberships.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "team-artifacts-" })),
  Layer.provideMerge(NodeServices.layer),
);

const artifactRule = (error: unknown) => {
  assert.instanceOf(error, TeamArtifacts.TeamArtifactError);
  return error.rule;
};
const membershipRule = (error: unknown) => {
  assert.instanceOf(error, TeamMemberships.TeamMembershipError);
  return error.rule;
};

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(effect.pipe(Effect.result), (result) =>
    Result.isFailure(result) ? result.failure : assert.fail("expected failure"),
  );

const TEXT = new TextEncoder().encode("artifact-body");

const seed = Effect.gen(function* () {
  const members = yield* TeamMemberships.TeamMembershipRepository;
  const artifacts = yield* TeamArtifacts.TeamArtifactRepository;
  yield* members.inviteUser({ id: "alice", subject: "invited:alice", name: "Alice" });
  yield* members.inviteUser({ id: "bob", subject: "invited:bob", name: "Bob" });
  yield* members.inviteUser({ id: "carol", subject: "invited:carol", name: "Carol" });
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
  return { members, artifacts };
});

it.effect("members read, permitted roles write, Owner controls ACL, Viewer is read-only", () =>
  Effect.gen(function* () {
    const { members, artifacts } = yield* seed;
    const published = yield* artifacts.publish("invited:alice", "a", {
      name: "report.html",
      mimeType: "text/html",
      run: { threadId: "thread-1", ref: "turn-7" },
      sourceUrl: "https://media.example.com/bearer-secret/abc",
      content: TEXT,
    });
    assert.equal(published.id.startsWith("art_"), true);
    assert.equal(published.version, 1);
    assert.equal(published.ownerUserId, "alice");
    assert.equal(published.ownerName, "Alice");
    assert.equal(published.workspaceId, "a");
    assert.equal(published.projectId, "project-a");
    assert.equal(published.visibility, "workspace");
    assert.deepEqual(published.run, { threadId: "thread-1", ref: "turn-7" });

    // The member-facing shape carries no host path and no upstream link.
    const wire = JSON.parse(JSON.stringify(published)) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(wire).filter((key) => /storage|source|path|dir/i.test(key)),
      [],
    );
    assert.equal(JSON.stringify(wire).includes("bearer-secret"), false);

    yield* members.setMember("invited:alice", "a", "bob", "Editor");
    yield* members.setMember("invited:alice", "a", "carol", "Viewer");
    for (const subject of ["invited:alice", "invited:bob", "invited:carol"]) {
      assert.deepEqual(
        (yield* artifacts.list(subject, "a")).map((artifact) => artifact.id),
        [published.id],
      );
      const detail = yield* artifacts.detail(subject, "a", published.id);
      assert.equal(detail.name, "report.html");
      assert.equal(
        (yield* artifacts.openContent(subject, "a", published.id, "inline")).fileName,
        "report.html",
      );
      assert.equal(
        (yield* artifacts.openContent(subject, "a", published.id, "download")).download,
        true,
      );
    }

    const fs = yield* FileSystem.FileSystem;
    const opened = yield* artifacts.openContent("invited:bob", "a", published.id, "inline");
    assert.deepEqual(new TextDecoder().decode(yield* fs.readFile(opened.path)), "artifact-body");

    const byEditor = yield* artifacts.publish("invited:bob", "a", {
      name: "notes.txt",
      mimeType: "text/plain",
      content: TEXT,
    });
    assert.equal(byEditor.ownerUserId, "bob");

    for (const denied of [
      artifacts.publish("invited:carol", "a", { name: "x.txt", content: TEXT }),
      artifacts.importDryRun("invited:carol", "a", [{ id: "n1" }]),
    ] as ReadonlyArray<Effect.Effect<unknown, TeamArtifacts.StoreError>>) {
      const deniedResult = yield* denied.pipe(Effect.result);
      assert.isTrue(Result.isFailure(deniedResult));
      if (Result.isFailure(deniedResult)) {
        assert.equal(artifactRule(deniedResult.failure), "viewer_write_denied");
      }
    }
    for (const denied of [
      artifacts.setVisibility("invited:carol", "a", published.id, "private"),
      artifacts.setVisibility("invited:bob", "a", published.id, "private"),
    ] as ReadonlyArray<Effect.Effect<unknown, TeamArtifacts.StoreError>>) {
      const deniedResult = yield* denied.pipe(Effect.result);
      assert.isTrue(Result.isFailure(deniedResult));
      if (Result.isFailure(deniedResult)) {
        assert.equal(membershipRule(deniedResult.failure), "owner_required");
      }
    }

    const updated = yield* artifacts.setVisibility("invited:alice", "a", published.id, "private");
    assert.equal(updated.version, 2);
    assert.equal(updated.visibility, "private");
    yield* artifacts.setVisibility("invited:alice", "a", published.id, "workspace");
    assert.equal((yield* artifacts.detail("invited:alice", "a", published.id)).version, 3);

    assert.equal(
      artifactRule(
        yield* failureOf(
          artifacts.publish("invited:alice", "a", {
            id: published.id,
            name: "dup.txt",
            content: TEXT,
          }),
        ),
      ),
      "artifact_exists",
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("denies nonmembers and cross-workspace access on every resource path", () =>
  Effect.gen(function* () {
    const { artifacts } = yield* seed;
    const published = yield* artifacts.publish("invited:alice", "a", {
      name: "a.txt",
      content: TEXT,
    });
    const foreign = yield* artifacts.publish("invited:bob", "b", {
      name: "b.txt",
      content: TEXT,
    });

    for (const denied of [
      artifacts.list("uninvited", "a"),
      artifacts.detail("uninvited", "a", published.id),
      artifacts.openContent("uninvited", "a", published.id, "inline"),
      artifacts.publish("uninvited", "a", { name: "x", content: TEXT }),
    ] as ReadonlyArray<Effect.Effect<unknown, TeamArtifacts.StoreError>>) {
      const deniedResult = yield* denied.pipe(Effect.result);
      assert.isTrue(Result.isFailure(deniedResult));
      if (Result.isFailure(deniedResult)) {
        assert.equal(membershipRule(deniedResult.failure), "invited_user_required");
      }
    }
    for (const denied of [
      artifacts.list("invited:bob", "a"),
      artifacts.detail("invited:bob", "a", published.id),
      artifacts.openContent("invited:bob", "a", published.id, "download"),
      artifacts.publish("invited:bob", "a", { name: "x", content: TEXT }),
      artifacts.setVisibility("invited:bob", "a", published.id, "private"),
      artifacts.importDryRun("invited:bob", "a", [{ id: "n1" }]),
      artifacts.detail("invited:alice", "b", foreign.id),
    ] as ReadonlyArray<Effect.Effect<unknown, TeamArtifacts.StoreError>>) {
      const deniedResult = yield* denied.pipe(Effect.result);
      assert.isTrue(Result.isFailure(deniedResult));
      if (Result.isFailure(deniedResult)) {
        assert.equal(membershipRule(deniedResult.failure), "workspace_membership_required");
      }
    }
    assert.equal(
      membershipRule(yield* failureOf(artifacts.list("invited:alice", "b"))),
      "workspace_membership_required",
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("denies removed members on the next request without cached grants", () =>
  Effect.gen(function* () {
    const { members, artifacts } = yield* seed;
    const published = yield* artifacts.publish("invited:alice", "a", {
      name: "a.txt",
      content: TEXT,
    });
    yield* members.setMember("invited:alice", "a", "bob", "Editor");
    yield* members.setMember("invited:alice", "a", "carol", "Viewer");
    assert.equal((yield* artifacts.detail("invited:bob", "a", published.id)).id, published.id);
    assert.equal((yield* artifacts.detail("invited:carol", "a", published.id)).id, published.id);

    yield* members.removeMember("invited:alice", "a", "bob");
    yield* members.removeMember("invited:alice", "a", "carol");
    for (const denied of [
      artifacts.list("invited:bob", "a"),
      artifacts.detail("invited:bob", "a", published.id),
      artifacts.openContent("invited:bob", "a", published.id, "download"),
      artifacts.publish("invited:bob", "a", { name: "x", content: TEXT }),
      artifacts.detail("invited:carol", "a", published.id),
      artifacts.openContent("invited:carol", "a", published.id, "inline"),
    ] as ReadonlyArray<Effect.Effect<unknown, TeamArtifacts.StoreError>>) {
      const deniedResult = yield* denied.pipe(Effect.result);
      assert.isTrue(Result.isFailure(deniedResult));
      if (Result.isFailure(deniedResult)) {
        assert.equal(membershipRule(deniedResult.failure), "workspace_membership_required");
      }
    }
    yield* members.setMember("invited:alice", "a", "bob", "Viewer");
    assert.equal((yield* artifacts.detail("invited:bob", "a", published.id)).id, published.id);
    assert.equal(
      artifactRule(
        yield* failureOf(artifacts.publish("invited:bob", "a", { name: "x", content: TEXT })),
      ),
      "viewer_write_denied",
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("keeps private and unknown-owner artifacts private", () =>
  Effect.gen(function* () {
    const { members, artifacts } = yield* seed;
    yield* members.setMember("invited:alice", "a", "bob", "Editor");
    const mine = yield* artifacts.publish("invited:alice", "a", {
      name: "mine.txt",
      visibility: "private",
      content: TEXT,
    });
    const shared = yield* artifacts.publish("invited:alice", "a", {
      name: "shared.txt",
      content: TEXT,
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO team_artifacts
        (id, workspace_id, project_id, owner_user_id, name, visibility, version,
         storage_key, size_bytes, mime_type, source_url, run_thread_id, run_ref,
         created_at, updated_at)
      VALUES ('orphan', 'a', 'project-a', 'ghost', 'legacy.bin', 'workspace', 4,
              NULL, 9, 'application/octet-stream', 'https://bearer.example/x',
              NULL, NULL, 0, 0)
    `;
    yield* sql`
      INSERT INTO team_artifacts
        (id, workspace_id, project_id, owner_user_id, name, visibility, version,
         storage_key, size_bytes, mime_type, source_url, run_thread_id, run_ref,
         created_at, updated_at)
      VALUES ('nullowner', 'a', 'project-a', NULL, 'legacy2.bin', 'workspace', 2,
              NULL, 9, NULL, NULL, NULL, NULL, 0, 0)
    `;

    assert.deepEqual(
      (yield* artifacts.list("invited:bob", "a")).map((artifact) => artifact.id).sort(),
      [shared.id].sort(),
    );
    for (const denied of [
      artifacts.detail("invited:bob", "a", mine.id),
      artifacts.openContent("invited:bob", "a", mine.id, "inline"),
      artifacts.detail("invited:alice", "a", "orphan"),
      artifacts.openContent("invited:alice", "a", "orphan", "download"),
      artifacts.detail("invited:alice", "a", "nullowner"),
      artifacts.setVisibility("invited:alice", "a", "orphan", "private"),
      artifacts.setVisibility("invited:alice", "a", "nullowner", "private"),
    ] as ReadonlyArray<Effect.Effect<unknown, TeamArtifacts.StoreError>>) {
      const deniedResult = yield* denied.pipe(Effect.result);
      assert.isTrue(Result.isFailure(deniedResult));
      if (Result.isFailure(deniedResult)) {
        assert.equal(artifactRule(deniedResult.failure), "artifact_not_found");
      }
    }
    assert.equal((yield* artifacts.detail("invited:alice", "a", mine.id)).visibility, "private");
    assert.equal(
      (yield* artifacts.openContent("invited:alice", "a", mine.id, "download")).download,
      true,
    );

    const externalOnly = yield* artifacts.publish("invited:alice", "a", {
      name: "external.mp4",
      mimeType: "video/mp4",
      sourceUrl: "https://media.example.com/bearer-secret/vid",
    });
    assert.equal(externalOnly.sizeBytes, 0);
    assert.equal(
      artifactRule(
        yield* failureOf(artifacts.openContent("invited:alice", "a", externalOnly.id, "inline")),
      ),
      "artifact_content_unavailable",
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("plans a synthetic dry-run import and writes nothing", () =>
  Effect.gen(function* () {
    const { members, artifacts } = yield* seed;
    yield* members.setMember("invited:alice", "a", "bob", "Editor");
    const existing = yield* artifacts.publish("invited:alice", "a", {
      id: "art_existing",
      name: "old.txt",
      content: TEXT,
    });
    const manifest: ReadonlyArray<TeamArtifacts.TeamArtifactImportEntry> = [
      { id: "imp1", name: "one.txt", version: 1, ownerUserId: "alice" },
      { id: "imp2", name: "two.bin", version: 3, visibility: "private", ownerUserId: "ghost" },
      { id: "art_existing", name: "old.txt", version: 1 },
      { id: "art_existing", name: "old2.txt", version: 9 },
      { id: "bad id!", name: "bad" },
      { id: "v0", version: 0 },
      { id: "vneg", version: -2 },
      { id: "badvis", visibility: "shared" as TeamArtifacts.TeamArtifactVisibility },
    ];
    const before = yield* artifacts.list("invited:alice", "a");
    for (const subject of ["invited:alice", "invited:bob"]) {
      const plan = yield* artifacts.importDryRun(subject, "a", manifest);
      assert.equal(plan.received, manifest.length);
      assert.deepEqual(plan.wouldCreate, [
        { id: "imp1", version: 1 },
        { id: "imp2", version: 3 },
      ]);
      assert.deepEqual(plan.conflicts, [
        { id: "art_existing", incomingVersion: 1, existingVersion: existing.version },
      ]);
      assert.deepEqual(
        plan.invalid.map((entry) => entry.reason),
        ["id_duplicate", "id_invalid", "version_invalid", "version_invalid", "visibility_invalid"],
      );
    }
    assert.deepEqual(
      (yield* artifacts.list("invited:alice", "a")).map((artifact) => artifact.id),
      before.map((artifact) => artifact.id),
    );
    assert.equal(
      (yield* artifacts.detail("invited:alice", "a", existing.id)).version,
      existing.version,
    );
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* sql`SELECT id FROM team_artifacts WHERE id LIKE 'imp%'`, []);

    yield* members.setMember("invited:alice", "a", "bob", "Viewer");
    assert.equal(
      artifactRule(yield* failureOf(artifacts.importDryRun("invited:bob", "a", [{ id: "x" }]))),
      "viewer_write_denied",
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("preserves registry rows and ACL state across a SQLite reopen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "team-artifacts-" });
    const dbPath = path.join(directory, "state.sqlite");
    const config = yield* ServerConfig.ServerConfig;
    const open = () =>
      TeamArtifacts.layer.pipe(
        Layer.provideMerge(TeamMemberships.layer),
        Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
        Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
      );

    const published = yield* Effect.gen(function* () {
      const { artifacts, members } = yield* seed;
      yield* members.setMember("invited:alice", "a", "bob", "Editor");
      const artifact = yield* artifacts.publish("invited:alice", "a", {
        name: "persist.txt",
        content: TEXT,
      });
      yield* artifacts.setVisibility("invited:alice", "a", artifact.id, "private");
      yield* members.removeMember("invited:alice", "a", "bob");
      return artifact;
    }).pipe(Effect.provide(open()));

    yield* Effect.gen(function* () {
      const artifacts = yield* TeamArtifacts.TeamArtifactRepository;
      const detail = yield* artifacts.detail("invited:alice", "a", published.id);
      assert.equal(detail.version, 2);
      assert.equal(detail.visibility, "private");
      assert.equal(
        membershipRule(yield* failureOf(artifacts.list("invited:bob", "a"))),
        "workspace_membership_required",
      );
      const opened = yield* artifacts.openContent("invited:alice", "a", published.id, "inline");
      const fs = yield* FileSystem.FileSystem;
      assert.deepEqual(new TextDecoder().decode(yield* fs.readFile(opened.path)), "artifact-body");
    }).pipe(Effect.provide(open()));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "team-artifacts-cfg-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("maps real invitation sessions to artifact ACLs and honors revocation", () => {
  const layer = Layer.mergeAll(TeamArtifacts.layer, EnvironmentAuth.layer).pipe(
    Layer.provideMerge(TeamMemberships.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "team-artifact-auth-" })),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return Effect.gen(function* () {
    const { members } = yield* seed;
    const artifacts = yield* TeamArtifacts.TeamArtifactRepository;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const login = Effect.fn("test.loginInvitedMember")(function* (subject: string) {
      const invitation = yield* auth.createPairingLink({
        subject,
        scopes: ["orchestration:read", "orchestration:operate"],
      });
      const exchange = yield* auth.createBrowserSession(invitation.credential, {
        deviceType: "desktop",
      });
      return HttpServerRequest.fromWeb(
        new Request("http://localhost/team/rpc", {
          headers: { cookie: `${sessions.cookieName}=${exchange.sessionToken}` },
        }),
      );
    });
    const subjectOf = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.map(auth.authenticateHttpRequest(request), (session) => session.subject);

    const aliceRequest = yield* login("invited:alice");
    const bobRequest = yield* login("invited:bob");
    const alice = yield* subjectOf(aliceRequest);
    yield* members.setMember(alice, "a", "bob", "Editor");

    const published = yield* artifacts.publish(alice, "a", {
      name: "session.txt",
      content: TEXT,
      run: { threadId: "thread-auth", ref: "run-9" },
    });
    assert.equal(
      (yield* artifacts.detail(yield* subjectOf(bobRequest), "a", published.id)).run?.ref,
      "run-9",
    );

    yield* members.removeMember(alice, "a", "bob");
    assert.equal(
      membershipRule(
        yield* failureOf(artifacts.detail(yield* subjectOf(bobRequest), "a", published.id)),
      ),
      "workspace_membership_required",
    );

    const invalidated = yield* Deferred.make<void>();
    const bobSession = yield* auth.authenticateHttpRequest(bobRequest);
    yield* sessions
      .awaitInvalidation(bobSession.sessionId)
      .pipe(
        Effect.andThen(Deferred.succeed(invalidated, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      );
    assert.isTrue(yield* auth.revokeSession(bobSession.sessionId));
    yield* Deferred.await(invalidated);
    const rejected = yield* failureOf(auth.authenticateHttpRequest(bobRequest));
    assert.isTrue(EnvironmentAuth.isServerAuthCredentialError(rejected));

    const reconnected = yield* auth.authenticateHttpRequest(yield* login("invited:bob"));
    assert.equal(
      membershipRule(yield* failureOf(artifacts.detail(reconnected.subject, "a", published.id))),
      "workspace_membership_required",
    );
    yield* members.setMember(alice, "a", "bob", "Viewer");
    assert.equal(
      (yield* artifacts.detail(reconnected.subject, "a", published.id)).id,
      published.id,
    );
  }).pipe(Effect.provide(layer));
});
