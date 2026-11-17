import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
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
import * as Sqlite from "./Sqlite.ts";
import * as TeamMemberships from "./TeamMemberships.ts";

const database = Sqlite.layerMemory;
const membersLayer = TeamMemberships.layer.pipe(Layer.provideMerge(database));

function membershipRule(error: unknown) {
  assert.instanceOf(error, TeamMemberships.TeamMembershipError);
  return error.rule;
}

const seed = Effect.gen(function* () {
  const members = yield* TeamMemberships.TeamMembershipRepository;
  yield* members.inviteUser({ id: "alice", subject: "invited:alice", name: "Alice" });
  yield* members.inviteUser({ id: "bob", subject: "invited:bob", name: "Bob" });
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
  return members;
});

it.effect("resolves only invited subjects and current workspace membership", () =>
  Effect.gen(function* () {
    const members = yield* seed;
    assert.deepEqual(
      (yield* members.listWorkspaces("invited:alice")).map((w) => w.id),
      ["a"],
    );
    assert.deepEqual(
      (yield* members.listWorkspaces("invited:bob")).map((w) => w.id),
      ["b"],
    );
    assert.equal((yield* members.resolve("invited:alice", "a")).role, "Owner");
    const missing = yield* members.resolve("uninvited", "a").pipe(Effect.flip);
    assert.instanceOf(missing, TeamMemberships.TeamMembershipError);
    assert.equal(missing.rule, "invited_user_required");
    for (const request of [
      members.resolve("invited:bob", "a"),
      members.listMembers("invited:bob", "a"),
      members.renameWorkspace("invited:bob", "a", "stolen"),
      members.deleteWorkspace("invited:bob", "a"),
      members.setMember("invited:bob", "a", "bob", "Owner"),
      members.removeMember("invited:bob", "a", "alice"),
    ]) {
      const error = yield* request.pipe(Effect.flip);
      assert.instanceOf(error, TeamMemberships.TeamMembershipError);
      assert.equal(error.rule, "workspace_membership_required");
    }
    assert.equal((yield* members.resolve("invited:alice", "a")).name, "A");
  }).pipe(Effect.provide(membersLayer)),
);

it.effect("applies Owner-only changes and revocation without cached grants", () =>
  Effect.gen(function* () {
    const members = yield* seed;
    for (const role of ["Editor", "Viewer"] as const) {
      yield* members.setMember("invited:alice", "a", "bob", role);
      assert.equal((yield* members.resolve("invited:bob", "a")).role, role);
      for (const request of [
        members.setMember("invited:bob", "a", "bob", "Owner"),
        members.removeMember("invited:bob", "a", "alice"),
        members.renameWorkspace("invited:bob", "a", "unauthorized"),
        members.deleteWorkspace("invited:bob", "a"),
      ]) {
        const error = yield* request.pipe(Effect.flip);
        assert.instanceOf(error, TeamMemberships.TeamMembershipError);
        assert.equal(error.rule, "owner_required");
      }
    }
    yield* members.removeMember("invited:alice", "a", "bob");
    assert.equal(
      membershipRule(yield* members.resolve("invited:bob", "a").pipe(Effect.flip)),
      "workspace_membership_required",
    );
    assert.deepEqual(
      (yield* members.listWorkspaces("invited:bob")).map((w) => w.id),
      ["b"],
    );
    yield* members.setMember("invited:alice", "a", "bob", "Editor");
    assert.equal((yield* members.resolve("invited:bob", "a")).role, "Editor");
    assert.equal(
      membershipRule(
        yield* members.setMember("invited:alice", "a", "uninvited", "Viewer").pipe(Effect.flip),
      ),
      "invited_user_required",
    );
  }).pipe(Effect.provide(membersLayer)),
);

it.effect("keeps an owner through role changes and rolls back invalid updates", () =>
  Effect.gen(function* () {
    const members = yield* seed;
    for (const change of [
      members.setMember("invited:alice", "a", "alice", "Editor"),
      members.removeMember("invited:alice", "a", "alice"),
    ]) {
      assert.equal(membershipRule(yield* change.pipe(Effect.flip)), "last_owner_required");
    }
    yield* members.setMember("invited:alice", "a", "bob", "Owner");
    const changes = yield* Effect.all(
      [
        members.setMember("invited:alice", "a", "alice", "Editor").pipe(Effect.result),
        members.setMember("invited:bob", "a", "bob", "Editor").pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(changes.filter((result) => result._tag === "Success").length, 1);
    assert.equal(
      (yield* members.listMembers("invited:alice", "a")).filter((m) => m.role === "Owner").length,
      1,
    );
    const owner =
      (yield* members.resolve("invited:alice", "a")).role === "Owner"
        ? "invited:alice"
        : "invited:bob";
    assert.equal(
      (yield* members.renameWorkspace(owner, "a", "").pipe(Effect.flip))._tag,
      "PersistenceSqlError",
    );
    assert.equal((yield* members.resolve(owner, "a")).name, "A");
    yield* members.renameWorkspace(owner, "a", "Renamed");
    assert.equal((yield* members.resolve(owner, "a")).name, "Renamed");
    yield* members.deleteWorkspace(owner, "a");
    assert.equal(
      membershipRule(yield* members.resolve(owner, "a").pipe(Effect.flip)),
      "workspace_membership_required",
    );
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* sql`SELECT * FROM team_memberships WHERE workspace_id = 'a'`, []);
  }).pipe(Effect.provide(membersLayer)),
);

it.effect("enforces unique identities, valid roles and membership foreign keys", () =>
  Effect.gen(function* () {
    const members = yield* seed;
    assert.equal(
      (yield* members
        .inviteUser({ id: "eve", subject: "invited:alice", name: "Eve" })
        .pipe(Effect.flip))._tag,
      "PersistenceSqlError",
    );
    const sql = yield* SqlClient.SqlClient;
    for (const invalid of [
      sql`INSERT INTO team_memberships VALUES ('a', 'bob', 'Admin')`,
      sql`INSERT INTO team_memberships VALUES ('unknown', 'bob', 'Viewer')`,
      sql`INSERT INTO team_memberships VALUES ('a', 'unknown', 'Viewer')`,
      sql`INSERT INTO team_users VALUES ('bad.id', 'invited:eve', 'Eve')`,
    ]) {
      assert.equal((yield* invalid.pipe(Effect.flip))._tag, "SqlError");
    }
    assert.equal((yield* members.resolve("invited:alice", "a")).userId, "alice");
  }).pipe(Effect.provide(membersLayer)),
);

it.effect(
  "preserves users, workspaces and changed memberships after closing and reopening SQLite",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "team-members-" });
      const dbPath = path.join(directory, "state.sqlite");
      const open = () =>
        TeamMemberships.layer.pipe(Layer.provideMerge(Sqlite.layerFromPath(dbPath)));
      yield* Effect.gen(function* () {
        const members = yield* seed;
        yield* members.setMember("invited:alice", "a", "bob", "Editor");
        yield* members.renameWorkspace("invited:alice", "a", "Persistent");
      }).pipe(Effect.provide(open()));
      yield* Effect.gen(function* () {
        const members = yield* TeamMemberships.TeamMembershipRepository;
        assert.deepEqual(yield* members.resolve("invited:bob", "a"), {
          id: "a",
          projectId: "project-a",
          name: "Persistent",
          userId: "bob",
          role: "Editor",
        });
        yield* members.removeMember("invited:alice", "a", "bob");
      }).pipe(Effect.provide(open()));
      yield* Effect.gen(function* () {
        const members = yield* TeamMemberships.TeamMembershipRepository;
        assert.equal(
          membershipRule(yield* members.resolve("invited:bob", "a").pipe(Effect.flip)),
          "workspace_membership_required",
        );
        assert.equal((yield* members.resolve("invited:alice", "a")).role, "Owner");
      }).pipe(Effect.provide(open()));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("maps real invitation login sessions to durable membership and honors logout", () => {
  const layer = Layer.mergeAll(TeamMemberships.layer, EnvironmentAuth.layer).pipe(
    Layer.provideMerge(database),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "team-member-auth-" })),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return Effect.gen(function* () {
    const members = yield* seed;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const login = Effect.fn("test.loginInvitedMember")(function* (subject: string) {
      const invitation = yield* auth.createPairingLink({ subject, scopes: ["orchestration:read"] });
      const exchange = yield* auth.createBrowserSession(invitation.credential, {
        deviceType: "desktop",
      });
      return HttpServerRequest.fromWeb(
        new Request("http://localhost/team/rpc", {
          headers: { cookie: `${sessions.cookieName}=${exchange.sessionToken}` },
        }),
      );
    });
    const aliceRequest = yield* login("invited:alice");
    const bobRequest = yield* login("invited:bob");
    const alice = yield* auth.authenticateHttpRequest(aliceRequest);
    const bob = yield* auth.authenticateHttpRequest(bobRequest);
    assert.notEqual(alice.sessionId, bob.sessionId);
    assert.equal((yield* members.resolve(alice.subject, "a")).role, "Owner");
    assert.equal(
      membershipRule(yield* members.resolve(bob.subject, "a").pipe(Effect.flip)),
      "workspace_membership_required",
    );
    yield* members.setMember(alice.subject, "a", "bob", "Viewer");
    assert.equal(
      (yield* members.resolve((yield* auth.authenticateHttpRequest(bobRequest)).subject, "a")).role,
      "Viewer",
    );
    yield* members.removeMember(alice.subject, "a", "bob");
    assert.equal(
      membershipRule(
        yield* members
          .resolve((yield* auth.authenticateHttpRequest(bobRequest)).subject, "a")
          .pipe(Effect.flip),
      ),
      "workspace_membership_required",
    );

    const invalidated = yield* Deferred.make<void>();
    yield* sessions
      .awaitInvalidation(bob.sessionId)
      .pipe(
        Effect.andThen(Deferred.succeed(invalidated, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      );
    assert.isTrue(yield* auth.revokeSession(bob.sessionId));
    yield* Deferred.await(invalidated);
    const rejected = yield* auth.authenticateHttpRequest(bobRequest).pipe(Effect.flip);
    assert.isTrue(EnvironmentAuth.isServerAuthCredentialError(rejected));
    assert.equal((yield* auth.authenticateHttpRequest(aliceRequest)).subject, alice.subject);
    const reconnected = yield* auth.authenticateHttpRequest(yield* login("invited:bob"));
    assert.notEqual(reconnected.sessionId, bob.sessionId);
    assert.equal((yield* members.resolve(reconnected.subject, "b")).userId, "bob");
    assert.equal(
      membershipRule(yield* members.resolve(reconnected.subject, "a").pipe(Effect.flip)),
      "workspace_membership_required",
    );
  }).pipe(Effect.provide(layer));
});
