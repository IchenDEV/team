import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as NodeOS from "node:os";

import { layer as processRunnerLayer } from "../processRunner.ts";
import { DockerSandbox, layer as dockerSandboxLayer } from "./DockerSandbox.ts";
import {
  TeamExecutionBoundary,
  layer as boundaryLayer,
  type TeamIsolationConfig,
} from "./TeamExecutionBoundary.ts";

const suffix = Buffer.from(SecureRandom.randomBytesUnsafe(3)).toString("hex");
const WS_A = `alpha${suffix}`;
const WS_B = `beta${suffix}`;
const stateDir = `${NodeOS.homedir()}/.t3-team-isolation-test-${suffix}`;
const dockerName = (runId: string) => `t3ex-${runId.replaceAll(".", "-")}`;

const config: TeamIsolationConfig = {
  users: [
    { id: "alice", token: "a".repeat(32) },
    { id: "bob", token: "b".repeat(32) },
    { id: "carol", token: "c".repeat(32) },
  ],
  memberships: [
    { userId: "alice", workspaceId: WS_A, role: "Editor" },
    { userId: "bob", workspaceId: WS_B, role: "Owner" },
    { userId: "carol", workspaceId: WS_A, role: "Viewer" },
  ],
  workspaces: [
    {
      id: WS_A,
      credentials: { T3_TENANT_CREDENTIAL: `cred-canary-a-${suffix}` },
      networkMode: "none",
    },
    {
      id: WS_B,
      credentials: { T3_TENANT_CREDENTIAL: `cred-canary-b-${suffix}` },
      networkMode: "none",
    },
  ],
};

const alice = { authorization: `Bearer ${"a".repeat(32)}` };
const bob = { authorization: `Bearer ${"b".repeat(32)}` };
const carol = { authorization: `Bearer ${"c".repeat(32)}` };

const dockerFull = dockerSandboxLayer({}).pipe(
  Layer.provideMerge(processRunnerLayer),
  Layer.provideMerge(NodeServices.layer),
);
const env = Layer.mergeAll(
  boundaryLayer({ config, stateDir }).pipe(Layer.provide(dockerFull)),
  dockerFull,
);

const cleanup = Effect.gen(function* () {
  const sandbox = yield* DockerSandbox;
  const fs = yield* FileSystem.FileSystem;
  yield* sandbox.removeWorkspaceRuns(WS_A).pipe(Effect.ignore);
  yield* sandbox.removeWorkspaceRuns(WS_B).pipe(Effect.ignore);
  yield* fs.remove(stateDir, { recursive: true, force: true }).pipe(Effect.ignore);
});

it.live(
  "confines each tenant run to its workspace sandbox and denies revoked or cancelled work",
  () =>
    Effect.acquireUseRelease(
      Effect.undefined,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const boundary = yield* TeamExecutionBoundary;
          const sandbox = yield* DockerSandbox;
          const rootA = `${stateDir}/workspaces/${WS_A}/root`;
          const rootB = `${stateDir}/workspaces/${WS_B}/root`;
          yield* fs.makeDirectory(rootA, { recursive: true });
          yield* fs.makeDirectory(rootB, { recursive: true });
          yield* fs.writeFileString(`${rootA}/canary.txt`, `canary-a-${suffix}`);
          yield* fs.writeFileString(`${rootB}/canary-b.txt`, `canary-b-secret-${suffix}`);

          // Authentication, membership and role guards.
          const anonymous = yield* Effect.flip(
            boundary.start(undefined, {
              workspaceId: WS_A,
              commandId: "anon",
              text: "echo hi",
            }),
          );
          assert.equal(anonymous.rule, "authentication_required");
          const wrongTenant = yield* Effect.flip(
            boundary.start(alice.authorization, {
              workspaceId: WS_B,
              commandId: "cross",
              text: "echo hi",
            }),
          );
          assert.equal(wrongTenant.rule, "workspace_membership_required");
          const viewer = yield* Effect.flip(
            boundary.start(carol.authorization, {
              workspaceId: WS_A,
              commandId: "view",
              text: "echo hi",
            }),
          );
          assert.equal(viewer.rule, "viewer_execution_forbidden");

          // Tenant B keeps a live run as a cross-tenant process canary.
          const bRun = yield* boundary.start(bob.authorization, {
            workspaceId: WS_B,
            commandId: "stayalive",
            text: "sleep 300",
          });
          assert.equal(bRun.status, "running");

          // Authorized same-tenant work runs and reports status.
          const aWork = yield* boundary.start(alice.authorization, {
            workspaceId: WS_A,
            commandId: "readown",
            text: "cat /workspace/canary.txt",
          });
          yield* sandbox.waitRun(dockerName(aWork.id));
          const aDone = yield* boundary.read(alice.authorization, {
            workspaceId: WS_A,
            runId: aWork.id,
          });
          assert.equal(aDone.status, "completed");
          assert.deepEqual(aDone.output, [`canary-a-${suffix}`]);

          // Malicious tenant-A run cannot reach tenant-B files.
          const fileAttack = yield* boundary.start(alice.authorization, {
            workspaceId: WS_A,
            commandId: "attackfs",
            text: "find / -name '*canary*' 2>/dev/null; cat /workspace*/canary-b.txt /canary-b.txt 2>/dev/null",
          });
          yield* sandbox.waitRun(dockerName(fileAttack.id));
          const fsOut = (yield* boundary.read(alice.authorization, {
            workspaceId: WS_A,
            runId: fileAttack.id,
          })).output.join("\n");
          assert.isTrue(fsOut.includes("/workspace/canary.txt"));
          assert.isFalse(fsOut.includes("canary-b.txt"));
          assert.isFalse(fsOut.includes(`canary-b-secret-${suffix}`));

          // Malicious tenant-A run cannot inspect tenant-B processes.
          const procAttack = yield* boundary.start(alice.authorization, {
            workspaceId: WS_A,
            commandId: "attackps",
            text: "ps",
          });
          yield* sandbox.waitRun(dockerName(procAttack.id));
          const psOut = (yield* boundary.read(alice.authorization, {
            workspaceId: WS_A,
            runId: procAttack.id,
          })).output.join("\n");
          assert.isTrue(psOut.includes("ps"));
          assert.isFalse(psOut.includes("sleep 300"));
          assert.isFalse(psOut.includes(dockerName(bRun.id)));

          // Malicious tenant-A run cannot obtain tenant-B credential canaries.
          const envAttack = yield* boundary.start(alice.authorization, {
            workspaceId: WS_A,
            commandId: "attackenv",
            text: "env; cat /proc/1/environ | tr '\\0' '\\n'",
          });
          yield* sandbox.waitRun(dockerName(envAttack.id));
          const envOut = (yield* boundary.read(alice.authorization, {
            workspaceId: WS_A,
            runId: envAttack.id,
          })).output.join("\n");
          assert.isTrue(envOut.includes(`T3_TENANT_CREDENTIAL=cred-canary-a-${suffix}`));
          assert.isTrue(envOut.includes(`T3_TEAM_WORKSPACE=${WS_A}`));
          assert.isFalse(envOut.includes(`cred-canary-b-${suffix}`));

          // Reconnect keeps the stable run reference and output.
          const reconnected = yield* boundary.read(alice.authorization, {
            workspaceId: WS_A,
            runId: aWork.id,
          });
          assert.equal(reconnected.nativeRunId, aDone.nativeRunId);
          assert.equal(reconnected.status, "completed");
          const bStillRunning = yield* boundary.read(bob.authorization, {
            workspaceId: WS_B,
            runId: bRun.id,
          });
          assert.equal(bStillRunning.status, "running");

          // Cross-tenant reads are denied even with a real run id.
          const crossRead = yield* Effect.flip(
            boundary.read(alice.authorization, { workspaceId: WS_B, runId: bRun.id }),
          );
          assert.equal(crossRead.rule, "workspace_membership_required");
          const crossReadBack = yield* Effect.flip(
            boundary.read(bob.authorization, { workspaceId: WS_A, runId: aWork.id }),
          );
          assert.equal(crossReadBack.rule, "workspace_membership_required");

          // Completed same-tenant work publishes an artifact.
          const pubRun = yield* boundary.start(alice.authorization, {
            workspaceId: WS_A,
            commandId: "publishwork",
            text: "echo report-content > /workspace/out/report.txt",
          });
          yield* sandbox.waitRun(dockerName(pubRun.id));
          const published = yield* boundary.publishArtifact(alice.authorization, {
            workspaceId: WS_A,
            runId: pubRun.id,
            name: "report.txt",
          });
          const publishedText = yield* fs.readFileString(published.path);
          assert.equal(publishedText.trim(), "report-content");
          const viewerPublish = yield* Effect.flip(
            boundary.publishArtifact(carol.authorization, {
              workspaceId: WS_A,
              runId: pubRun.id,
              name: "report.txt",
            }),
          );
          assert.equal(viewerPublish.rule, "viewer_execution_forbidden");

          // Idempotent command replay returns the same run; a changed body conflicts.
          const replay = yield* boundary.start(alice.authorization, {
            workspaceId: WS_A,
            commandId: "readown",
            text: "cat /workspace/canary.txt",
          });
          assert.equal(replay.nativeRunId, aDone.nativeRunId);
          const conflict = yield* Effect.flip(
            boundary.start(alice.authorization, {
              workspaceId: WS_A,
              commandId: "readown",
              text: "echo different",
            }),
          );
          assert.equal(conflict.rule, "command_conflict");

          // Cancellation kills the run and denies artifact publication.
          const longRun = yield* boundary.start(alice.authorization, {
            workspaceId: WS_A,
            commandId: "longrun",
            text: "sleep 300",
          });
          const cancelled = yield* boundary.cancel(alice.authorization, {
            workspaceId: WS_A,
            runId: longRun.id,
          });
          assert.equal(cancelled.status, "cancelled");
          const cancelledPublish = yield* Effect.flip(
            boundary.publishArtifact(alice.authorization, {
              workspaceId: WS_A,
              runId: longRun.id,
              name: "anything",
            }),
          );
          assert.equal(cancelledPublish.rule, "executor_failure");

          // Revocation kills live runs and denies new work, reads and publication.
          yield* boundary.revoke(WS_B);
          const revokedStart = yield* Effect.flip(
            boundary.start(bob.authorization, {
              workspaceId: WS_B,
              commandId: "afterrevoke",
              text: "echo hi",
            }),
          );
          assert.equal(revokedStart.rule, "workspace_membership_required");
          const revokedRead = yield* Effect.flip(
            boundary.read(bob.authorization, { workspaceId: WS_B, runId: bRun.id }),
          );
          assert.equal(revokedRead.rule, "workspace_membership_required");
          const revokedPublish = yield* Effect.flip(
            boundary.publishArtifact(bob.authorization, {
              workspaceId: WS_B,
              runId: bRun.id,
              name: "x",
            }),
          );
          assert.equal(revokedPublish.rule, "workspace_membership_required");
          const bRunGone = yield* Effect.flip(sandbox.readRun(dockerName(bRun.id)));
          assert.equal(bRunGone._tag, "SandboxRunNotFound");

          // Workspace A is unaffected by tenant-B revocation.
          const aAfterRevoke = yield* boundary.read(alice.authorization, {
            workspaceId: WS_A,
            runId: aWork.id,
          });
          assert.equal(aAfterRevoke.status, "completed");
        }),
      () => cleanup,
    ).pipe(Effect.provide(env)),
);

const noDocker = dockerSandboxLayer({ dockerPath: "/nonexistent-t3-docker" }).pipe(
  Layer.provideMerge(processRunnerLayer),
  Layer.provideMerge(NodeServices.layer),
);
const noDockerEnv = Layer.mergeAll(
  boundaryLayer({
    config: { ...config, workspaces: [{ ...config.workspaces[0]!, id: WS_A }] },
    stateDir: `${stateDir}-nodocker`,
  }).pipe(Layer.provide(noDocker)),
  NodeServices.layer,
);

it.live("fails closed when no container sandbox is available", () =>
  Effect.acquireUseRelease(
    Effect.undefined,
    () =>
      Effect.gen(function* () {
        const boundary = yield* TeamExecutionBoundary;
        const denied = yield* Effect.flip(
          boundary.start(alice.authorization, {
            workspaceId: WS_A,
            commandId: "nosandbox",
            text: "echo hi",
          }),
        );
        assert.equal(denied.rule, "executor_failure");
      }),
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .remove(`${stateDir}-nodocker`, { recursive: true, force: true })
          .pipe(Effect.ignore);
      }),
  ).pipe(Effect.provide(noDockerEnv)),
);
