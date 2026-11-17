import {
  TeamError,
  TeamId,
  type TeamReadInput,
  type TeamRun,
  type TeamStartInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  DockerSandbox,
  SandboxUnavailable,
  type SandboxError,
  type SandboxWorkspaceSpec,
} from "./DockerSandbox.ts";
import { TeamConfig } from "./TeamControlPlane.ts";

const SandboxWorkspace = Schema.Struct({
  id: TeamId,
  credentials: Schema.Record(Schema.String, Schema.String),
  networkMode: Schema.optional(Schema.Literals(["none", "bridge"])),
});

export const TeamIsolationConfig = Schema.Struct({
  users: TeamConfig.fields.users,
  memberships: TeamConfig.fields.memberships,
  workspaces: Schema.Array(SandboxWorkspace),
});
export type TeamIsolationConfig = typeof TeamIsolationConfig.Type;

export class TeamExecutionBoundary extends Context.Service<
  TeamExecutionBoundary,
  {
    readonly start: (
      authorization: string | undefined,
      input: TeamStartInput,
    ) => Effect.Effect<TeamRun, TeamError>;
    readonly read: (
      authorization: string | undefined,
      input: TeamReadInput,
    ) => Effect.Effect<TeamRun, TeamError>;
    readonly cancel: (
      authorization: string | undefined,
      input: TeamReadInput,
    ) => Effect.Effect<TeamRun, TeamError>;
    readonly revoke: (workspaceId: string) => Effect.Effect<void, SandboxError>;
    readonly publishArtifact: (
      authorization: string | undefined,
      input: { readonly workspaceId: string; readonly runId: string; readonly name: string },
    ) => Effect.Effect<{ readonly path: string }, TeamError>;
  }
>()("t3/team/TeamExecutionBoundary") {}

const dockerName = (runId: string) => `t3ex-${runId.replaceAll(".", "-")}`;

const RUN_ID_PATTERN = /^team\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}$/;

const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const RUN_STATUS = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

const make = Effect.fn("TeamExecutionBoundary.make")(function* (options: {
  readonly config: TeamIsolationConfig;
  readonly stateDir: string;
}) {
  const sandbox = yield* DockerSandbox;
  const fs = yield* FileSystem.FileSystem;
  const { config } = options;

  // Workspace roots are boundary-owned paths under stateDir; a project directory is
  // never used as a sandbox.
  const specOf = (workspace: (typeof config.workspaces)[number]): SandboxWorkspaceSpec => ({
    id: workspace.id,
    root: `${options.stateDir}/workspaces/${workspace.id}/root`,
    credentialsFile: `${options.stateDir}/workspaces/${workspace.id}/credentials.env`,
    networkMode: workspace.networkMode ?? "none",
  });

  const revokedMarker = (workspaceId: string) =>
    `${options.stateDir}/workspaces/${workspaceId}/REVOKED`;

  const isRevoked = (workspaceId: string) =>
    fs.exists(revokedMarker(workspaceId)).pipe(Effect.orElseSucceed(() => true));

  const authorize = Effect.fn("TeamExecutionBoundary.authorize")(function* (
    authorization: string | undefined,
    workspaceId: string,
    execute: boolean,
  ) {
    const user = config.users.find((candidate) => authorization === `Bearer ${candidate.token}`);
    if (!user) return yield* new TeamError({ rule: "authentication_required" });
    const membership = config.memberships.find(
      (candidate) => candidate.userId === user.id && candidate.workspaceId === workspaceId,
    );
    const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!membership || !workspace || (yield* isRevoked(workspaceId)))
      return yield* new TeamError({ rule: "workspace_membership_required" });
    if (execute && membership.role === "Viewer")
      return yield* new TeamError({ rule: "viewer_execution_forbidden" });
    return { user, workspace };
  });

  const sandboxErrors = {
    SandboxRunNotFound: () => new TeamError({ rule: "run_not_found" as const }),
    SandboxRunConflict: () => new TeamError({ rule: "command_conflict" as const }),
    SandboxUnavailable: () => new TeamError({ rule: "executor_failure" as const }),
  };

  const scopedRunId = (workspaceId: string, runId: string) =>
    RUN_ID_PATTERN.test(runId) && runId.startsWith(`team.${workspaceId}.`);

  const readRunByName = Effect.fn("TeamExecutionBoundary.readRunByName")(function* (runId: string) {
    const info = yield* sandbox.readRun(dockerName(runId)).pipe(Effect.catchTags(sandboxErrors));
    return {
      id: runId,
      nativeRunId: dockerName(runId),
      status: RUN_STATUS[info.status],
      output: [...info.output],
    } satisfies TeamRun;
  });

  return TeamExecutionBoundary.of({
    start: Effect.fn("TeamExecutionBoundary.start")(function* (authorization, input) {
      const { user, workspace } = yield* authorize(authorization, input.workspaceId, true);
      const spec = specOf(workspace);
      const runId = `team.${workspace.id}.${user.id}.${input.commandId}`;
      yield* sandbox
        .ensureWorkspace(spec, workspace.credentials)
        .pipe(Effect.catchTags(sandboxErrors));
      yield* sandbox
        .startRun(spec, dockerName(runId), input.text)
        .pipe(Effect.catchTags(sandboxErrors));
      return yield* readRunByName(runId);
    }),

    read: Effect.fn("TeamExecutionBoundary.read")(function* (authorization, input) {
      yield* authorize(authorization, input.workspaceId, false);
      if (!scopedRunId(input.workspaceId, input.runId))
        return yield* new TeamError({ rule: "run_not_found" });
      return yield* readRunByName(input.runId);
    }),

    cancel: Effect.fn("TeamExecutionBoundary.cancel")(function* (authorization, input) {
      yield* authorize(authorization, input.workspaceId, true);
      if (!scopedRunId(input.workspaceId, input.runId))
        return yield* new TeamError({ rule: "run_not_found" });
      yield* sandbox.cancelRun(dockerName(input.runId)).pipe(Effect.catchTags(sandboxErrors));
      return yield* readRunByName(input.runId);
    }),

    revoke: Effect.fn("TeamExecutionBoundary.revoke")(function* (workspaceId) {
      const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) return;
      yield* sandbox.removeWorkspaceRuns(workspaceId);
      yield* fs
        .makeDirectory(`${options.stateDir}/workspaces/${workspaceId}`, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SandboxUnavailable({
                operation: "workspace.revoke",
                detail: String(cause),
              }),
          ),
        );
      yield* fs.writeFileString(revokedMarker(workspaceId), "").pipe(
        Effect.mapError(
          (cause) =>
            new SandboxUnavailable({
              operation: "workspace.revoke",
              detail: String(cause),
            }),
        ),
      );
    }),

    publishArtifact: Effect.fn("TeamExecutionBoundary.publishArtifact")(
      function* (authorization, input) {
        const { workspace } = yield* authorize(authorization, input.workspaceId, true);
        if (!scopedRunId(input.workspaceId, input.runId) || !ARTIFACT_NAME_PATTERN.test(input.name))
          return yield* new TeamError({ rule: "run_not_found" });
        const info = yield* sandbox
          .readRun(dockerName(input.runId))
          .pipe(Effect.catchTags(sandboxErrors));
        if (info.status !== "completed") return yield* new TeamError({ rule: "executor_failure" });
        const source = `${specOf(workspace).root}/out/${input.name}`;
        const targetDir = `${options.stateDir}/published/${workspace.id}`;
        const target = `${targetDir}/${input.name}`;
        yield* fs
          .makeDirectory(targetDir, { recursive: true })
          .pipe(Effect.mapError(() => new TeamError({ rule: "executor_failure" })));
        yield* fs
          .copyFile(source, target)
          .pipe(Effect.mapError(() => new TeamError({ rule: "run_not_found" })));
        return { path: target };
      },
    ),
  });
});

export const layer = (options: { config: TeamIsolationConfig; stateDir: string }) =>
  Layer.effect(TeamExecutionBoundary, make(options));
