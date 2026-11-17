import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect ships no plain sync SHA-256; the conflict digest is a pure function.
import * as NodeCrypto from "node:crypto";

import { ProcessRunner } from "../processRunner.ts";

export class SandboxUnavailable extends Schema.TaggedError<SandboxUnavailable>()(
  "SandboxUnavailable",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Execution sandbox unavailable for ${this.operation}: ${this.detail}`;
  }
}

export class SandboxRunNotFound extends Schema.TaggedError<SandboxRunNotFound>()(
  "SandboxRunNotFound",
  { runName: Schema.String },
) {}

export class SandboxRunConflict extends Schema.TaggedError<SandboxRunConflict>()(
  "SandboxRunConflict",
  { runName: Schema.String },
) {}

export type SandboxError = SandboxUnavailable | SandboxRunNotFound | SandboxRunConflict;

export type SandboxRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface SandboxWorkspaceSpec {
  readonly id: string;
  /** Boundary-owned private root, mounted as the run's only writable tree. A project directory is never used as a sandbox. */
  readonly root: string;
  /** Restricted environment credential scope file outside the mounted root; injected into this workspace's runs only. */
  readonly credentialsFile: string;
  readonly networkMode: "none" | "bridge";
}

export interface SandboxRunInfo {
  readonly status: SandboxRunStatus;
  readonly output: ReadonlyArray<string>;
  readonly textDigest: string;
}

const WORKSPACE_LABEL = "t3.team.workspace";
const RUN_LABEL = "t3.team.run";
const TEXT_DIGEST_LABEL = "t3.team.text-digest";
// A container killed by `docker kill` reports ExitCode 137 (128 + SIGKILL).
const KILLED_EXIT_CODE = 137;

export class DockerSandbox extends Context.Service<
  DockerSandbox,
  {
    readonly ensureWorkspace: (
      workspace: SandboxWorkspaceSpec,
      credentials: Readonly<Record<string, string>>,
    ) => Effect.Effect<void, SandboxError>;
    readonly startRun: (
      workspace: SandboxWorkspaceSpec,
      runName: string,
      text: string,
    ) => Effect.Effect<void, SandboxError>;
    readonly readRun: (runName: string) => Effect.Effect<SandboxRunInfo, SandboxError>;
    readonly waitRun: (runName: string) => Effect.Effect<SandboxRunInfo, SandboxError>;
    readonly cancelRun: (runName: string) => Effect.Effect<void, SandboxError>;
    readonly removeWorkspaceRuns: (workspaceId: string) => Effect.Effect<void, SandboxError>;
  }
>()("t3/team/DockerSandbox") {}

const make = Effect.fn("DockerSandbox.make")(function* (options: {
  readonly dockerPath: string;
  readonly image: string;
}) {
  const runner = yield* ProcessRunner;
  const fs = yield* FileSystem.FileSystem;

  const docker = Effect.fn("DockerSandbox.docker")(function* (
    args: ReadonlyArray<string>,
    operation: string,
  ) {
    const output = yield* runner
      .run({ command: options.dockerPath, args: [...args], timeout: "2 minutes" })
      .pipe(
        Effect.mapError(
          () =>
            new SandboxUnavailable({
              operation,
              detail: `cannot spawn ${options.dockerPath}`,
            }),
        ),
      );
    return output;
  });

  const available = yield* docker(["info", "--format", "{{.ServerVersion}}"], "docker.info").pipe(
    Effect.map((output) => output.code === 0),
    Effect.catchTags({ SandboxUnavailable: () => Effect.succeed(false) }),
    Effect.cached,
  );

  const requireAvailable = (operation: string) =>
    Effect.flatMap(available, (ok) =>
      ok
        ? Effect.void
        : new SandboxUnavailable({
            operation,
            detail: `no container runtime at ${options.dockerPath}`,
          }),
    );

  const runChecked = Effect.fn("DockerSandbox.runChecked")(function* (
    args: ReadonlyArray<string>,
    operation: string,
  ) {
    const output = yield* docker(args, operation);
    if (output.code !== 0) {
      return yield* new SandboxUnavailable({
        operation,
        detail: output.stderr.trim() || `exit code ${output.code}`,
      });
    }
    return output.stdout;
  });

  const readRun = Effect.fn("DockerSandbox.readRun")(function* (runName: string) {
    const inspected = yield* docker(
      ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", runName],
      "run.inspect",
    );
    if (inspected.code !== 0) {
      const detail = inspected.stderr.trim();
      return yield* detail.toLowerCase().includes("no such")
        ? new SandboxRunNotFound({ runName })
        : new SandboxUnavailable({
            operation: "run.inspect",
            detail: inspected.stderr.trim() || `exit code ${inspected.code}`,
          });
    }
    const [state = "", exitCodeText = "0"] = inspected.stdout.trim().split(" ");
    const exitCode = Number.parseInt(exitCodeText, 10);
    const status: SandboxRunStatus =
      state === "running" || state === "created" || state === "restarting"
        ? "running"
        : exitCode === 0
          ? "completed"
          : exitCode === KILLED_EXIT_CODE
            ? "cancelled"
            : "failed";
    const logs = yield* docker(["logs", runName], "run.logs");
    const textDigest = yield* docker(
      ["inspect", "--format", `{{index .Config.Labels "${TEXT_DIGEST_LABEL}"}}`, runName],
      "run.inspect",
    ).pipe(
      Effect.map((output) => output.stdout.trim()),
      Effect.orElseSucceed(() => ""),
    );
    return {
      status,
      output: [...logs.stdout.split("\n"), ...logs.stderr.split("\n")].filter(
        (line) => line.length > 0,
      ),
      textDigest,
    } satisfies SandboxRunInfo;
  });

  return DockerSandbox.of({
    ensureWorkspace: Effect.fn("DockerSandbox.ensureWorkspace")(function* (workspace, credentials) {
      yield* requireAvailable("workspace.ensure");
      yield* fs.makeDirectory(`${workspace.root}/out`, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new SandboxUnavailable({
              operation: "workspace.ensure",
              detail: `cannot prepare root ${workspace.root}: ${String(cause)}`,
            }),
        ),
      );
      yield* fs
        .writeFileString(
          workspace.credentialsFile,
          Object.entries(credentials)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n"),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new SandboxUnavailable({
                operation: "workspace.ensure",
                detail: `cannot write credential scope: ${String(cause)}`,
              }),
          ),
          Effect.tap(() => fs.chmod(workspace.credentialsFile, 0o600).pipe(Effect.ignore)),
        );
      yield* runChecked(["pull", options.image], "workspace.ensure").pipe(
        Effect.catchTags({ SandboxUnavailable: () => Effect.void }),
      );
    }),

    startRun: Effect.fn("DockerSandbox.startRun")(function* (workspace, runName, text) {
      yield* requireAvailable("run.start");
      const textDigest = NodeCrypto.createHash("sha256").update(text).digest("hex");
      const existing = yield* readRun(runName).pipe(
        Effect.map((info) => info as SandboxRunInfo | undefined),
        Effect.catchTags({ SandboxRunNotFound: () => Effect.undefined }),
      );
      if (existing !== undefined) {
        return yield* existing.textDigest === textDigest
          ? Effect.void
          : new SandboxRunConflict({ runName });
      }
      yield* runChecked(
        [
          "run",
          "--detach",
          "--name",
          runName,
          "--label",
          `${WORKSPACE_LABEL}=${workspace.id}`,
          "--label",
          `${RUN_LABEL}=${runName}`,
          "--label",
          `${TEXT_DIGEST_LABEL}=${textDigest}`,
          "--network",
          workspace.networkMode,
          "--env-file",
          workspace.credentialsFile,
          "--env",
          `T3_TEAM_WORKSPACE=${workspace.id}`,
          "--volume",
          `${workspace.root}:/workspace:rw`,
          "--workdir",
          "/workspace",
          "--read-only",
          "--tmpfs",
          "/tmp",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "64",
          "--memory",
          "256m",
          options.image,
          "sh",
          "-c",
          text,
        ],
        "run.start",
      );
    }),

    readRun,

    waitRun: Effect.fn("DockerSandbox.waitRun")(function* (runName: string) {
      yield* requireAvailable("run.wait");
      yield* readRun(runName);
      const waited = yield* docker(["wait", runName], "run.wait");
      if (waited.code !== 0) {
        return yield* waited.stderr.trim().toLowerCase().includes("no such")
          ? new SandboxRunNotFound({ runName })
          : new SandboxUnavailable({
              operation: "run.wait",
              detail: waited.stderr.trim() || `exit code ${waited.code}`,
            });
      }
      // `docker wait` prints the container exit code when it unblocks and is
      // authoritative: a follow-up inspect can briefly report the pre-exit
      // state on containerd-backed engines.
      const exitCode = Number.parseInt(waited.stdout.trim(), 10);
      const info = yield* readRun(runName);
      if (Number.isNaN(exitCode)) return info;
      const status: SandboxRunStatus =
        exitCode === 0 ? "completed" : exitCode === KILLED_EXIT_CODE ? "cancelled" : "failed";
      return { ...info, status };
    }),

    cancelRun: Effect.fn("DockerSandbox.cancelRun")(function* (runName: string) {
      yield* requireAvailable("run.cancel");
      const info = yield* readRun(runName);
      if (info.status === "running") {
        yield* runChecked(["kill", runName], "run.cancel");
      }
    }),

    removeWorkspaceRuns: Effect.fn("DockerSandbox.removeWorkspaceRuns")(function* (
      workspaceId: string,
    ) {
      yield* requireAvailable("workspace.removeRuns");
      const list = yield* docker(
        ["ps", "-aq", "--filter", `label=${WORKSPACE_LABEL}=${workspaceId}`],
        "workspace.listRuns",
      );
      const names = list.stdout.split("\n").filter((line) => line.length > 0);
      if (names.length > 0) yield* docker(["rm", "-f", ...names], "workspace.removeRuns");
    }),
  });
});

export const layer = (options: { readonly dockerPath?: string; readonly image?: string }) =>
  Layer.effect(
    DockerSandbox,
    make({
      dockerPath: options.dockerPath ?? "docker",
      image: options.image ?? "busybox:1.37",
    }),
  );
