import type { TeamRun } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  DockerSandbox,
  SandboxRunNotFound,
  SandboxUnavailable,
  type SandboxError,
  type SandboxWorkspaceSpec,
} from "./DockerSandbox.ts";

export class SandboxRevoked extends Schema.TaggedError<SandboxRevoked>()("SandboxRevoked", {
  workspaceId: Schema.String,
}) {}

export type BoundaryError = SandboxError | SandboxRevoked;

// The workspace record the control plane already resolved for an authenticated
// member; the boundary never re-authenticates.
export interface SandboxWorkspace {
  readonly id: string;
  readonly credentials: Record<string, string>;
  readonly networkMode: "none" | "bridge";
}

const RUN_ID_PATTERN = /^team\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}$/;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The run id is used verbatim as the container name so the mapping stays
// injective: dots and hyphens are both legal id characters, and flattening
// dots to hyphens let distinct ids alias one container across workspaces.
const dockerName = (runId: string) => `t3ex-${runId}`;

export const scopedRunId = (workspaceId: string, runId: string) =>
  RUN_ID_PATTERN.test(runId) && runId.startsWith(`team.${workspaceId}.`);

export class TeamExecutionBoundary extends Context.Service<
  TeamExecutionBoundary,
  {
    readonly start: (
      workspace: SandboxWorkspace,
      runId: string,
      text: string,
    ) => Effect.Effect<void, BoundaryError>;
    readonly read: (
      workspace: SandboxWorkspace,
      runId: string,
    ) => Effect.Effect<TeamRun, BoundaryError>;
    readonly wait: (runId: string) => Effect.Effect<TeamRun, BoundaryError>;
    readonly cancel: (
      workspace: SandboxWorkspace,
      runId: string,
    ) => Effect.Effect<TeamRun, BoundaryError>;
    readonly dropWorkspace: (workspaceId: string) => Effect.Effect<void, BoundaryError>;
    readonly publishArtifact: (
      workspace: SandboxWorkspace,
      runId: string,
      name: string,
    ) => Effect.Effect<{ readonly path: string }, BoundaryError>;
  }
>()("t3/team/TeamExecutionBoundary") {}

const make = Effect.fn("TeamExecutionBoundary.make")(function* (options: {
  readonly stateDir: string;
}) {
  const sandbox = yield* DockerSandbox;
  const fs = yield* FileSystem.FileSystem;

  // Workspace roots are boundary-owned paths under stateDir; a project directory is
  // never used as a sandbox.
  const specOf = (workspace: SandboxWorkspace): SandboxWorkspaceSpec => ({
    id: workspace.id,
    root: `${options.stateDir}/workspaces/${workspace.id}/root`,
    credentialsFile: `${options.stateDir}/workspaces/${workspace.id}/credentials.env`,
    networkMode: workspace.networkMode,
  });

  const requireSpec = (workspace: SandboxWorkspace) =>
    options.stateDir
      ? Effect.succeed(specOf(workspace))
      : new SandboxUnavailable({
          operation: "sandbox",
          detail: "no sandbox state directory configured",
        });

  const revokedMarker = (workspaceId: string) =>
    `${options.stateDir}/workspaces/${workspaceId}/REVOKED`;

  const requireLive = (workspace: SandboxWorkspace) =>
    fs.exists(revokedMarker(workspace.id)).pipe(
      Effect.orElseSucceed(() => true),
      Effect.flatMap((revoked) =>
        revoked ? new SandboxRevoked({ workspaceId: workspace.id }) : Effect.void,
      ),
    );

  const toTeamRun = (runId: string, info: { status: string; output: ReadonlyArray<string> }) =>
    ({
      id: runId,
      nativeRunId: dockerName(runId),
      status: info.status as TeamRun["status"],
      output: [...info.output],
    }) satisfies TeamRun;

  const readScoped = Effect.fn("TeamExecutionBoundary.readScoped")(function* (
    workspace: SandboxWorkspace,
    runId: string,
  ) {
    if (!scopedRunId(workspace.id, runId)) return yield* new SandboxRunNotFound({ runName: runId });
    return toTeamRun(runId, yield* sandbox.readRun(dockerName(runId)));
  });

  return TeamExecutionBoundary.of({
    start: Effect.fn("TeamExecutionBoundary.start")(function* (workspace, runId, text) {
      if (!scopedRunId(workspace.id, runId))
        return yield* new SandboxRunNotFound({ runName: runId });
      yield* requireLive(workspace);
      const spec = yield* requireSpec(workspace);
      yield* sandbox.ensureWorkspace(spec, workspace.credentials);
      yield* sandbox.startRun(spec, dockerName(runId), text);
    }),

    read: Effect.fn("TeamExecutionBoundary.read")(function* (workspace, runId) {
      yield* requireLive(workspace);
      return yield* readScoped(workspace, runId);
    }),

    wait: Effect.fn("TeamExecutionBoundary.wait")(function* (runId) {
      const info = yield* sandbox.waitRun(dockerName(runId));
      return toTeamRun(runId, info);
    }),

    cancel: Effect.fn("TeamExecutionBoundary.cancel")(function* (workspace, runId) {
      yield* requireLive(workspace);
      if (!scopedRunId(workspace.id, runId))
        return yield* new SandboxRunNotFound({ runName: runId });
      yield* sandbox.cancelRun(dockerName(runId));
      return yield* readScoped(workspace, runId);
    }),

    // Deleting a workspace revokes it: kill every workspace run and leave a marker
    // so stale callers are denied even before membership rows settle. A missing
    // container runtime leaves nothing to clean, so the marker is still written.
    dropWorkspace: Effect.fn("TeamExecutionBoundary.dropWorkspace")(function* (workspaceId) {
      if (!options.stateDir) return;
      // The durable revocation marker is written before containers are killed
      // so in-flight and later starts are denied first; a marker-write failure
      // is never swallowed — it leaves the workspace visibly un-revoked.
      yield* fs
        .makeDirectory(`${options.stateDir}/workspaces/${workspaceId}`, { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(revokedMarker(workspaceId), "")),
          Effect.mapError(
            (cause) =>
              new SandboxUnavailable({
                operation: "workspace.revoke",
                detail: `cannot persist revocation for ${workspaceId}: ${String(cause)}`,
              }),
          ),
        );
      yield* sandbox.removeWorkspaceRuns(workspaceId).pipe(Effect.ignore);
    }),

    publishArtifact: Effect.fn("TeamExecutionBoundary.publishArtifact")(
      function* (workspace, runId, name) {
        yield* requireLive(workspace);
        if (!scopedRunId(workspace.id, runId) || !ARTIFACT_NAME_PATTERN.test(name))
          return yield* new SandboxRunNotFound({ runName: runId });
        // Eligibility rests on `docker wait`, which cannot return while the
        // container runs — inspect is only consulted for detail when a
        // genuinely running run hits the bound.
        const info = yield* sandbox.waitRun(dockerName(runId)).pipe(
          Effect.timeoutOption("5 seconds"),
          Effect.flatMap((outcome) =>
            outcome._tag === "Some"
              ? Effect.succeed(outcome.value)
              : sandbox.readRun(dockerName(runId)),
          ),
        );
        if (info.status !== "completed")
          return yield* new SandboxUnavailable({
            operation: "artifact.publish",
            detail:
              `run ${runId} did not complete (status: ${info.status}` +
              (info.output.length > 0 ? `, output: ${info.output.slice(-3).join(" | ")}` : "") +
              ")",
          });
        const spec = yield* requireSpec(workspace);
        const targetDir = `${options.stateDir}/published/${workspace.id}`;
        const target = `${targetDir}/${name}`;
        const ioError = new SandboxUnavailable({
          operation: "artifact.publish",
          detail: `cannot stage ${name} under ${targetDir}`,
        });
        yield* fs
          .makeDirectory(targetDir, { recursive: true })
          .pipe(Effect.mapError(() => ioError));
        yield* fs
          .copyFile(`${spec.root}/out/${name}`, target)
          .pipe(Effect.mapError(() => new SandboxRunNotFound({ runName: runId })));
        return { path: target };
      },
    ),
  });
});

export const layer = (options: { readonly stateDir: string }) =>
  Layer.effect(TeamExecutionBoundary, make(options));
