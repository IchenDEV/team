import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, ProviderInstanceId, TeamRpcGroup, TeamError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TeamControlPlane from "./TeamControlPlane.ts";
import * as TeamRuntime from "./TeamRuntime.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as SqlClient from "effect/sql/SqlClient";

const config: TeamControlPlane.TeamConfig = {
  workspaces: [
    ...["alpha", "beta", "gamma"].map((id) => ({
      id,
      projectId: ProjectId.make(id),
      modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "todo-list" },
    })),
    {
      id: "delta",
      projectId: ProjectId.make("gamma"),
      modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "todo-list" },
    },
  ],
};
const layer = TeamRuntime.layer(config).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "team-rpc-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const setup = Effect.gen(function* () {
  const repository = yield* TeamMemberships.TeamMembershipRepository;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const client = yield* RpcTest.makeClient(TeamRpcGroup).pipe(
    Effect.provide(TeamControlPlane.handlers),
  );
  for (const id of ["owner", "alice", "bob"])
    yield* repository.inviteUser({ id, subject: TeamControlPlane.userSubject(id), name: id });
  for (const id of ["alpha", "beta"])
    yield* repository.createWorkspace(TeamControlPlane.userSubject("owner"), {
      id,
      projectId: ProjectId.make(id),
      name: id,
    });
  const login = Effect.fn("test.login")(function* (id: string) {
    const invitation = yield* auth.createPairingLink({
      subject: TeamControlPlane.userSubject(id),
      scopes: ["orchestration:read"],
    });
    const token = yield* client["team.login"]({ credential: invitation.credential });
    return { headers: { authorization: `Bearer ${token.access_token}` } };
  });
  return { repository, client, auth, login, owner: yield* login("owner") };
});
const rule = (error: unknown) => {
  assert.instanceOf(error, TeamError);
  return error.rule;
};

it.effect("keeps no session row for a rejected login", () =>
  Effect.gen(function* () {
    const { auth, client, login } = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    const count = Effect.fn("test.sessionRowCount")(function* () {
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM auth_sessions`;
      return rows[0]?.count ?? 0;
    });
    const before = yield* count();
    for (const [subject, expected] of [
      [TeamControlPlane.userSubject("outsider"), "invited_user_required"],
      ["mcp-client", "authentication_required"],
    ] as const) {
      const invitation = yield* auth.createPairingLink({
        subject,
        scopes: ["orchestration:read"],
      });
      assert.equal(
        rule(yield* client["team.login"]({ credential: invitation.credential }).pipe(Effect.flip)),
        expected,
      );
      assert.equal(yield* count(), before, `${expected} must leave no session row`);
    }
    yield* login("alice");
    assert.equal(yield* count(), before + 1, "an accepted login still issues one session");
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps no session row when the issued session is revoked before verification", () =>
  Effect.gen(function* () {
    const { auth, client } = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    const rows = () =>
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM auth_sessions`.pipe(
        Effect.map((result) => result[0]?.count ?? 0),
      );
    const before = yield* rows();
    // A concurrent replace for the same subject and method revokes the row the exchange just wrote.
    yield* sql`CREATE TRIGGER revoke_issued_team_session AFTER INSERT ON auth_sessions
      BEGIN UPDATE auth_sessions SET revoked_at = '2000-01-01T00:00:00.000Z' WHERE session_id = NEW.session_id; END`;
    const invitation = yield* auth.createPairingLink({
      subject: TeamControlPlane.userSubject("alice"),
      scopes: ["orchestration:read"],
    });
    assert.equal(
      rule(yield* client["team.login"]({ credential: invitation.credential }).pipe(Effect.flip)),
      "authentication_required",
    );
    assert.equal(yield* rows(), before, "a session revoked before verification leaves no row");
  }).pipe(Effect.provide(layer)),
);

it.effect("cannot mint or re-mint an identity that exists in another workspace", () =>
  Effect.gen(function* () {
    const { repository, client, login, owner } = yield* setup;
    yield* repository.setMember(TeamControlPlane.userSubject("owner"), "beta", "alice", "Owner");
    yield* repository.removeMember(TeamControlPlane.userSubject("alice"), "beta", "owner");
    const alice = yield* login("alice");
    for (const userId of ["owner", "alice"]) {
      const invitation = yield* client["team.invite"](
        { workspaceId: "beta", userId, name: "Impersonated", role: "Owner" },
        alice,
      ).pipe(Effect.result);
      assert.equal(invitation._tag, "Failure", "Invitations must not mint an existing identity");
      if (invitation._tag === "Failure")
        assert.equal(rule(invitation.failure), "user_already_invited");
    }
    assert.deepEqual(
      (yield* client["team.members"]({ workspaceId: "beta" }, alice)).map((entry) => entry.userId),
      ["alice"],
    );
    // A first invitation that expires unredeemed leaves a global identity an Owner cannot re-mint,
    // in its own workspace or in another one. Membership grants are the only Owner-side remedy.
    yield* client["team.invite"](
      { workspaceId: "beta", userId: "pending", name: "Pending", role: "Editor" },
      alice,
    );
    for (const [workspaceId, options] of [
      ["beta", alice],
      ["alpha", owner],
    ] as const) {
      const reminted = yield* client["team.invite"](
        { workspaceId, userId: "pending", name: "Pending", role: "Owner" },
        options,
      ).pipe(Effect.result);
      assert.equal(reminted._tag, "Failure", "An expired invitation must not be re-minted");
      if (reminted._tag === "Failure") assert.equal(rule(reminted.failure), "user_already_invited");
    }
    assert.deepEqual(
      (yield* client["team.members"]({ workspaceId: "beta" }, alice)).map((entry) => [
        entry.userId,
        entry.role,
      ]),
      [
        ["alice", "Owner"],
        ["pending", "Editor"],
      ],
    );
    assert.deepEqual(
      (yield* client["team.members"]({ workspaceId: "alpha" }, owner)).map((entry) => entry.userId),
      ["owner"],
    );
    assert.deepEqual(
      (yield* client["team.workspaces"](undefined, owner)).map((workspace) => workspace.id),
      ["alpha"],
    );
    yield* client["team.setMember"](
      { workspaceId: "beta", userId: "owner", role: "Viewer" },
      alice,
    );
    assert.equal((yield* client["team.workspace"]({ workspaceId: "beta" }, owner)).role, "Viewer");
  }).pipe(Effect.provide(layer)),
);

it.effect("checks current identity and every workspace entry point across all roles", () =>
  Effect.gen(function* () {
    const { repository, client, login, owner } = yield* setup;
    const alice = yield* login("alice");
    const bob = yield* login("bob");
    let cases = 0;
    for (const role of ["Owner", "Editor", "Viewer"] as const) {
      yield* repository.setMember(TeamControlPlane.userSubject("owner"), "alpha", "alice", role);
      yield* repository.setMember(TeamControlPlane.userSubject("owner"), "beta", "bob", role);
      for (const [id, options] of [
        ["alice", alice],
        ["bob", bob],
      ] as const) {
        assert.deepEqual(
          (yield* client["team.workspaces"](undefined, options)).map((entry) => entry.id),
          [id === "alice" ? "alpha" : "beta"],
        );
        for (const workspaceId of ["alpha", "beta"]) {
          for (const authenticated of [false, true]) {
            const headers = authenticated ? options : {};
            const own = (id === "alice") === (workspaceId === "alpha");
            const denied = !authenticated
              ? "authentication_required"
              : !own
                ? "workspace_membership_required"
                : undefined;
            const readInput = { workspaceId, runId: "team.other.alice.command" };
            assert.equal(
              rule(yield* client["team.read"](readInput, headers).pipe(Effect.flip)),
              denied ?? "run_not_found",
            );
            cases++;
            if (denied) {
              for (const request of [
                client["team.workspace"]({ workspaceId }, headers),
                client["team.members"]({ workspaceId }, headers),
                client["team.renameWorkspace"]({ workspaceId, name: "changed" }, headers),
                client["team.deleteWorkspace"]({ workspaceId }, headers),
                client["team.setMember"]({ workspaceId, userId: id, role: "Owner" }, headers),
                client["team.removeMember"]({ workspaceId, userId: "owner" }, headers),
              ]) {
                assert.equal(rule(yield* request.pipe(Effect.flip)), denied);
                cases++;
              }
            }
            if (denied || role === "Viewer") {
              assert.equal(
                rule(
                  yield* client["team.start"](
                    { workspaceId, commandId: "command", text: "harmless" },
                    headers,
                  ).pipe(Effect.flip),
                ),
                denied ?? "viewer_execution_forbidden",
              );
              cases++;
            }
          }
        }
      }
    }
    assert.equal(cases, 152);
    assert.equal((yield* client["team.workspace"]({ workspaceId: "alpha" }, owner)).role, "Owner");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "supports invited membership CRUD, role changes and logout through existing sessions",
  () =>
    Effect.gen(function* () {
      const { client, owner } = yield* setup;
      yield* client["team.createWorkspace"]({ workspaceId: "gamma", name: "Gamma" }, owner);
      yield* client["team.renameWorkspace"]({ workspaceId: "gamma", name: "Renamed" }, owner);
      assert.equal(
        (yield* client["team.workspace"]({ workspaceId: "gamma" }, owner)).name,
        "Renamed",
      );
      const invited = yield* client["team.invite"](
        { workspaceId: "gamma", userId: "new-user", name: "Synthetic", role: "Editor" },
        owner,
      );
      const token = yield* client["team.login"](invited);
      assert.equal(
        rule(yield* client["team.login"](invited).pipe(Effect.flip)),
        "authentication_required",
      );
      const user = { headers: { authorization: `Bearer ${token.access_token}` } };
      for (const role of ["Editor", "Viewer"] as const) {
        yield* client["team.setMember"]({ workspaceId: "gamma", userId: "new-user", role }, owner);
        assert.equal((yield* client["team.workspace"]({ workspaceId: "gamma" }, user)).role, role);
        assert.equal(
          rule(
            yield* client["team.invite"](
              { workspaceId: "gamma", userId: "outsider", name: "Denied", role: "Owner" },
              user,
            ).pipe(Effect.flip),
          ),
          "owner_required",
        );
        assert.equal(
          rule(
            yield* client["team.setMember"](
              { workspaceId: "gamma", userId: "new-user", role: "Owner" },
              user,
            ).pipe(Effect.flip),
          ),
          "owner_required",
        );
      }
      // A second workspace keeps the environment session alive across the removal.
      yield* client["team.setMember"](
        { workspaceId: "beta", userId: "new-user", role: "Viewer" },
        owner,
      );
      yield* client["team.removeMember"]({ workspaceId: "gamma", userId: "new-user" }, owner);
      assert.equal(
        rule(yield* client["team.workspace"]({ workspaceId: "gamma" }, user).pipe(Effect.flip)),
        "workspace_membership_required",
      );
      yield* client["team.setMember"](
        { workspaceId: "gamma", userId: "new-user", role: "Editor" },
        owner,
      );
      yield* client["team.logout"](undefined, user);
      assert.equal(
        rule(yield* client["team.workspaces"](undefined, user).pipe(Effect.flip)),
        "authentication_required",
      );
      yield* client["team.deleteWorkspace"]({ workspaceId: "gamma" }, owner);
      assert.deepEqual(
        (yield* client["team.workspaces"](undefined, owner)).map((entry) => entry.id),
        ["alpha", "beta"],
      );
      assert.equal(
        rule(
          yield* client["team.createWorkspace"](
            { workspaceId: "gamma", name: "Gamma" },
            owner,
          ).pipe(Effect.flip),
        ),
        "workspace_identifier_reserved",
      );
      assert.equal(
        rule(yield* client["team.workspace"]({ workspaceId: "gamma" }, owner).pipe(Effect.flip)),
        "workspace_membership_required",
      );
      assert.equal(
        rule(
          yield* client["team.createWorkspace"](
            { workspaceId: "delta", name: "Delta" },
            owner,
          ).pipe(Effect.flip),
        ),
        "workspace_identifier_reserved",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("revokes the environment session once a removed member belongs to no workspace", () =>
  Effect.gen(function* () {
    const { client, owner } = yield* setup;
    yield* client["team.createWorkspace"]({ workspaceId: "gamma", name: "Gamma" }, owner);
    const invited = yield* client["team.invite"](
      { workspaceId: "gamma", userId: "solo", name: "Solo", role: "Viewer" },
      owner,
    );
    const token = yield* client["team.login"](invited);
    const user = { headers: { authorization: `Bearer ${token.access_token}` } };
    assert.equal((yield* client["team.workspace"]({ workspaceId: "gamma" }, user)).role, "Viewer");

    yield* client["team.removeMember"]({ workspaceId: "gamma", userId: "solo" }, owner);

    assert.equal(
      rule(yield* client["team.workspace"]({ workspaceId: "gamma" }, user).pipe(Effect.flip)),
      "authentication_required",
    );
  }).pipe(Effect.provide(layer)),
);
