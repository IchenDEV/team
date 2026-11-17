import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, TeamRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TeamControlPlane from "./TeamControlPlane.ts";

it.effect(
  "enforces identity, workspace membership and Viewer guards at both RPC entry points",
  () =>
    Effect.gen(function* () {
      let cases = 0;
      for (const role of ["Owner", "Editor", "Viewer"] as const) {
        const config: TeamControlPlane.TeamConfig = {
          users: [
            { id: "alice", token: "a".repeat(32) },
            { id: "bob", token: "b".repeat(32) },
          ],
          memberships: [
            { userId: "alice", workspaceId: "alpha", role },
            { userId: "bob", workspaceId: "beta", role },
          ],
          workspaces: ["alpha", "beta"].map((id) => ({
            id,
            projectId: ProjectId.make(id),
            modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "showcase" },
            rpcUrl: "ws://127.0.0.1:1/ws?orchestrationProtocol=2",
            bearer: "e".repeat(32),
          })),
        };
        const client = yield* RpcTest.makeClient(TeamRpcGroup).pipe(
          Effect.provide(
            TeamControlPlane.handlers.pipe(Layer.provide(TeamControlPlane.layer(config))),
          ),
        );
        for (const user of config.users) {
          for (const workspaceId of ["alpha", "beta"]) {
            for (const authenticated of [false, true]) {
              const headers = authenticated ? { authorization: `Bearer ${user.token}` } : {};
              const own = (user.id === "alice") === (workspaceId === "alpha");
              const commonRule = !authenticated
                ? "authentication_required"
                : !own
                  ? "workspace_membership_required"
                  : undefined;
              const read = yield* Effect.flip(
                client["team.read"](
                  { workspaceId, runId: "team.other.alice.command" },
                  { headers },
                ),
              );
              assert.equal(read.rule, commonRule ?? "run_not_found");
              cases++;
              if (commonRule !== undefined || role === "Viewer") {
                const start = yield* Effect.flip(
                  client["team.start"](
                    { workspaceId, commandId: "command", text: "harmless" },
                    { headers },
                  ),
                );
                assert.equal(start.rule, commonRule ?? "viewer_execution_forbidden");
                cases++;
              }
            }
          }
        }
      }
      assert.equal(cases, 44);
    }),
);
