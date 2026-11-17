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

const config: TeamControlPlane.TeamConfig = {
  workspaces: ["alpha", "beta", "gamma"].map((id) => ({
    id,
    projectId: ProjectId.make(id),
    modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "todo-list" },
    rpcUrl: "ws://127.0.0.1:1/ws?orchestrationProtocol=2",
    bearer: "e".repeat(32),
  })),
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
  return { repository, client, login, owner: yield* login("owner") };
});
const rule = (error: unknown) => {
  assert.instanceOf(error, TeamError);
  return error.rule;
};

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
    }).pipe(Effect.provide(layer)),
);
