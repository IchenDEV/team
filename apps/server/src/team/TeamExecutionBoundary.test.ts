import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ProjectId,
  ProviderInstanceId,
  TeamRpcGroup,
  TeamError,
  type TeamRun,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as NodeOS from "node:os";
import * as TeamControlPlane from "./TeamControlPlane.ts";
import * as TeamRuntime from "./TeamRuntime.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { TeamExecutionBoundary } from "./TeamExecutionBoundary.ts";
import { DockerSandbox, layer as dockerSandboxLayer } from "./DockerSandbox.ts";
import { layer as boundaryLayer } from "./TeamExecutionBoundary.ts";
import { layer as processRunnerLayer } from "../processRunner.ts";

const suffix = Buffer.from(SecureRandom.randomBytesUnsafe(3)).toString("hex");
const WS_A = `alpha${suffix}`;
// Suffixing tenant B's id exercises the run-id → container-name collision a
// flattened mapping allowed: team.<A>.twin-bob.x and team.<A>-twin.bob.x must
// resolve different containers.
const WS_B = `${WS_A}-twin`;
const stateDir = `${NodeOS.homedir()}/.t3-team-isolation-${suffix}`;
const dockerName = (runId: string) => `t3ex-${runId}`;

const workspace = (id: string) => ({
  id,
  projectId: ProjectId.make(id),
  modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "todo-list" },
  rpcUrl: "ws://127.0.0.1:1/ws?orchestrationProtocol=2",
  bearer: "e".repeat(32),
  credentials: { T3_TENANT_CREDENTIAL: `cred-canary-${id}` },
  networkMode: "none" as const,
});

const config: TeamControlPlane.TeamConfig = {
  sandboxStateDir: stateDir,
  workspaces: [workspace(WS_A), workspace(WS_B)],
};

const layer = TeamRuntime.layer(config).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "team-iso-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const setup = Effect.gen(function* () {
  const repository = yield* TeamMemberships.TeamMembershipRepository;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const boundary = yield* TeamExecutionBoundary;
  const sandbox = yield* DockerSandbox;
  const fs = yield* FileSystem.FileSystem;
  const client = yield* RpcTest.makeClient(TeamRpcGroup).pipe(
    Effect.provide(TeamControlPlane.handlers),
  );
  for (const id of ["owner", "alice", "bob", "carol"])
    yield* repository.inviteUser({
      id,
      subject: TeamControlPlane.userSubject(id),
      name: id,
    });
  for (const id of [WS_A, WS_B])
    yield* repository.createWorkspace(TeamControlPlane.userSubject("owner"), {
      id,
      projectId: ProjectId.make(id),
      name: id,
    });
  yield* repository.setMember(TeamControlPlane.userSubject("owner"), WS_A, "alice", "Editor");
  yield* repository.setMember(TeamControlPlane.userSubject("owner"), WS_B, "bob", "Owner");
  yield* repository.setMember(TeamControlPlane.userSubject("owner"), WS_A, "carol", "Viewer");
  const login = Effect.fn("test.login")(function* (id: string) {
    const invitation = yield* auth.createPairingLink({
      subject: TeamControlPlane.userSubject(id),
      scopes: ["orchestration:read"],
    });
    const token = yield* client["team.login"]({ credential: invitation.credential });
    return { headers: { authorization: `Bearer ${token.access_token}` } };
  });
  return {
    client,
    boundary,
    sandbox,
    fs,
    owner: yield* login("owner"),
    alice: yield* login("alice"),
    bob: yield* login("bob"),
    carol: yield* login("carol"),
  };
});

const rule = (error: unknown) => {
  assert.instanceOf(error, TeamError);
  return error.rule;
};

const wsA = {
  id: WS_A,
  credentials: { T3_TENANT_CREDENTIAL: `cred-canary-${WS_A}` },
  networkMode: "none" as const,
};

const waitAndRead = (
  boundary: TeamExecutionBoundary["Service"],
  runId: string,
  read: Effect.Effect<TeamRun, TeamError>,
) => Effect.andThen(boundary.wait(runId), read);

it.live(
  "confines each tenant run to its workspace sandbox and denies revoked or cancelled work",
  () =>
    Effect.acquireUseRelease(
      Effect.undefined,
      () =>
        Effect.gen(function* () {
          const { client, boundary, sandbox, fs, owner, alice, bob, carol } = yield* setup;
          const rootA = `${stateDir}/workspaces/${WS_A}/root`;
          const rootB = `${stateDir}/workspaces/${WS_B}/root`;
          yield* fs.makeDirectory(rootA, { recursive: true });
          yield* fs.makeDirectory(rootB, { recursive: true });
          yield* fs.writeFileString(`${rootA}/canary.txt`, `canary-a-${suffix}`);
          yield* fs.writeFileString(`${rootB}/canary-b.txt`, `canary-b-secret-${suffix}`);

          // Authentication, membership and role guards at the real RPC surface.
          assert.equal(
            rule(
              yield* client["team.start"](
                { workspaceId: WS_A, commandId: "anon", text: "echo hi" },
                { headers: {} },
              ).pipe(Effect.flip),
            ),
            "authentication_required",
          );
          assert.equal(
            rule(
              yield* client["team.start"](
                { workspaceId: WS_B, commandId: "cross", text: "echo hi" },
                alice,
              ).pipe(Effect.flip),
            ),
            "workspace_membership_required",
          );
          assert.equal(
            rule(
              yield* client["team.start"](
                { workspaceId: WS_A, commandId: "view", text: "echo hi" },
                carol,
              ).pipe(Effect.flip),
            ),
            "viewer_execution_forbidden",
          );

          // Tenant B keeps a live run as a cross-tenant process canary.
          const bRun: TeamRun = yield* client["team.start"](
            { workspaceId: WS_B, commandId: "stayalive", text: "sleep 300" },
            bob,
          );
          assert.equal(bRun.status, "running");

          // Authorized same-tenant work runs and reports status.
          const aWork = yield* client["team.start"](
            { workspaceId: WS_A, commandId: "readown", text: "cat /workspace/canary.txt" },
            alice,
          );
          const aDone = yield* waitAndRead(
            boundary,
            aWork.id,
            client["team.read"]({ workspaceId: WS_A, runId: aWork.id }, alice),
          );
          assert.equal(aDone.status, "completed");
          assert.deepEqual(aDone.output, [`canary-a-${suffix}`]);

          // Malicious tenant-A run cannot reach tenant-B files.
          const fileAttack = yield* client["team.start"](
            {
              workspaceId: WS_A,
              commandId: "attackfs",
              text: "find / -name '*canary*' 2>/dev/null; cat /workspace*/canary-b.txt /canary-b.txt 2>/dev/null",
            },
            alice,
          );
          const fsOut = (yield* waitAndRead(
            boundary,
            fileAttack.id,
            client["team.read"]({ workspaceId: WS_A, runId: fileAttack.id }, alice),
          )).output.join("\n");
          assert.isTrue(fsOut.includes("/workspace/canary.txt"));
          assert.isFalse(fsOut.includes("canary-b.txt"));
          assert.isFalse(fsOut.includes(`canary-b-secret-${suffix}`));

          // Malicious tenant-A run cannot inspect tenant-B processes.
          const procAttack = yield* client["team.start"](
            { workspaceId: WS_A, commandId: "attackps", text: "ps" },
            alice,
          );
          const psOut = (yield* waitAndRead(
            boundary,
            procAttack.id,
            client["team.read"]({ workspaceId: WS_A, runId: procAttack.id }, alice),
          )).output.join("\n");
          assert.isTrue(psOut.includes("ps"));
          assert.isFalse(psOut.includes("sleep 300"));
          assert.isFalse(psOut.includes(dockerName(bRun.id)));

          // A run id that would alias tenant B's container under a flattened
          // name mapping stays run_not_found for tenant A.
          assert.equal(
            rule(
              yield* client["team.read"](
                {
                  workspaceId: WS_A,
                  runId: `team.${WS_A}.twin-bob.stayalive`,
                },
                alice,
              ).pipe(Effect.flip),
            ),
            "run_not_found",
          );

          // Malicious tenant-A run cannot obtain tenant-B credential canaries.
          const envAttack = yield* client["team.start"](
            {
              workspaceId: WS_A,
              commandId: "attackenv",
              text: "env; cat /proc/1/environ | tr '\\0' '\\n'",
            },
            alice,
          );
          const envOut = (yield* waitAndRead(
            boundary,
            envAttack.id,
            client["team.read"]({ workspaceId: WS_A, runId: envAttack.id }, alice),
          )).output.join("\n");
          assert.isTrue(envOut.includes(`T3_TENANT_CREDENTIAL=cred-canary-${WS_A}`));
          assert.isTrue(envOut.includes(`T3_TEAM_WORKSPACE=${WS_A}`));
          assert.isFalse(envOut.includes(`cred-canary-${WS_B}`));

          // Reconnect keeps the stable run reference and output; stream reports it.
          const reconnected = yield* client["team.read"](
            { workspaceId: WS_A, runId: aWork.id },
            alice,
          );
          assert.equal(reconnected.nativeRunId, aDone.nativeRunId);
          assert.equal(reconnected.status, "completed");
          const streamed = yield* client["team.stream"](
            { workspaceId: WS_A, runId: aWork.id },
            alice,
          ).pipe(Stream.take(1), Stream.runCollect);
          assert.equal(streamed[0]?.status, "completed");

          // Cross-tenant reads are denied even with a real run id.
          assert.equal(
            rule(
              yield* client["team.read"]({ workspaceId: WS_B, runId: bRun.id }, alice).pipe(
                Effect.flip,
              ),
            ),
            "workspace_membership_required",
          );
          assert.equal(
            rule(
              yield* client["team.read"]({ workspaceId: WS_A, runId: aWork.id }, bob).pipe(
                Effect.flip,
              ),
            ),
            "workspace_membership_required",
          );

          // Completed same-tenant work publishes an artifact; viewers may not.
          const pubRun = yield* client["team.start"](
            {
              workspaceId: WS_A,
              commandId: "publishwork",
              text: "echo report-content > /workspace/out/report.txt",
            },
            alice,
          );
          yield* boundary.wait(pubRun.id);
          const published = yield* boundary.publishArtifact(wsA, pubRun.id, "report.txt");
          assert.equal((yield* fs.readFileString(published.path)).trim(), "report-content");

          // Idempotent command replay returns the same run; a changed body conflicts.
          const replay = yield* client["team.start"](
            { workspaceId: WS_A, commandId: "readown", text: "cat /workspace/canary.txt" },
            alice,
          );
          assert.equal(replay.nativeRunId, aDone.nativeRunId);
          assert.equal(
            rule(
              yield* client["team.start"](
                { workspaceId: WS_A, commandId: "readown", text: "echo different" },
                alice,
              ).pipe(Effect.flip),
            ),
            "command_conflict",
          );

          // Cancellation kills the run and denies artifact publication.
          const longRun = yield* client["team.start"](
            { workspaceId: WS_A, commandId: "longrun", text: "sleep 300" },
            alice,
          );
          const cancelled = yield* boundary.cancel(wsA, longRun.id);
          assert.equal(cancelled.status, "cancelled");
          const cancelledPublish = yield* boundary
            .publishArtifact(wsA, longRun.id, "anything.txt")
            .pipe(Effect.flip);
          assert.equal(cancelledPublish._tag, "SandboxUnavailable");

          // Deleting a workspace revokes it: live runs die, new work and reads deny.
          yield* client["team.deleteWorkspace"]({ workspaceId: WS_B }, owner);
          assert.equal(
            rule(
              yield* client["team.start"](
                { workspaceId: WS_B, commandId: "afterrevoke", text: "echo hi" },
                bob,
              ).pipe(Effect.flip),
            ),
            "workspace_membership_required",
          );
          assert.equal(
            rule(
              yield* client["team.read"]({ workspaceId: WS_B, runId: bRun.id }, bob).pipe(
                Effect.flip,
              ),
            ),
            "workspace_membership_required",
          );
          const bRunGone = yield* sandbox.readRun(dockerName(bRun.id)).pipe(Effect.flip);
          assert.equal(bRunGone._tag, "SandboxRunNotFound");

          // Workspace A is unaffected by tenant-B revocation.
          const aAfterRevoke = yield* client["team.read"](
            { workspaceId: WS_A, runId: aWork.id },
            alice,
          );
          assert.equal(aAfterRevoke.status, "completed");
        }),
      () =>
        Effect.gen(function* () {
          const boundary = yield* TeamExecutionBoundary;
          const fs = yield* FileSystem.FileSystem;
          yield* boundary.dropWorkspace(WS_A);
          yield* boundary.dropWorkspace(WS_B);
          yield* fs.remove(stateDir, { recursive: true, force: true }).pipe(Effect.ignore);
        }),
    ).pipe(Effect.provide(layer)),
);

const noStateLayer = TeamRuntime.layer({
  workspaces: [workspace(WS_A)],
}).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "team-iso-nostate-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.live("fails closed when no sandbox state directory or container runtime is available", () =>
  Effect.acquireUseRelease(
    Effect.undefined,
    () =>
      Effect.gen(function* () {
        const repository = yield* TeamMemberships.TeamMembershipRepository;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const client = yield* RpcTest.makeClient(TeamRpcGroup).pipe(
          Effect.provide(TeamControlPlane.handlers),
        );
        yield* repository.inviteUser({
          id: "alice",
          subject: TeamControlPlane.userSubject("alice"),
          name: "alice",
        });
        yield* repository.createWorkspace(TeamControlPlane.userSubject("alice"), {
          id: WS_A,
          projectId: ProjectId.make(WS_A),
          name: WS_A,
        });
        const invitation = yield* auth.createPairingLink({
          subject: TeamControlPlane.userSubject("alice"),
          scopes: ["orchestration:read"],
        });
        const token = yield* client["team.login"]({ credential: invitation.credential });
        const headers = { headers: { authorization: `Bearer ${token.access_token}` } };
        // The boundary has no state directory: execution refuses executor_failure,
        // never falling back to host execution.
        assert.equal(
          rule(
            yield* client["team.start"](
              { workspaceId: WS_A, commandId: "nosandbox", text: "echo hi" },
              headers,
            ).pipe(Effect.flip),
          ),
          "executor_failure",
        );
        // A boundary over an absent container runtime fails the same way.
        const brokenEnv = boundaryLayer({ stateDir }).pipe(
          Layer.provideMerge(dockerSandboxLayer({ dockerPath: "/nonexistent-t3-docker" })),
          Layer.provideMerge(processRunnerLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const denied = yield* Effect.service(TeamExecutionBoundary).pipe(
          Effect.flatMap((service) => service.start(wsA, `team.${WS_A}.alice.c1`, "echo hi")),
          Effect.flip,
          Effect.provide(brokenEnv),
        );
        assert.equal(denied._tag, "SandboxUnavailable");
      }),
    () => Effect.void,
  ).pipe(Effect.provide(noStateLayer)),
);
