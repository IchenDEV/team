// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { attachmentFileExtension } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";
import { TeamMembershipError, TeamMembershipRepository } from "../persistence/TeamMemberships.ts";

export const TEAM_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const TeamArtifactId = Schema.String.check(Schema.isPattern(TEAM_ARTIFACT_ID_PATTERN));
export const TeamArtifactVisibility = Schema.Literals(["workspace", "private"]);
export type TeamArtifactVisibility = typeof TeamArtifactVisibility.Type;

const ArtifactRow = Schema.Struct({
  id: TeamArtifactId,
  workspaceId: Schema.String,
  projectId: ProjectId,
  ownerUserId: Schema.NullOr(Schema.String),
  ownerName: Schema.NullOr(Schema.String),
  name: Schema.String,
  visibility: TeamArtifactVisibility,
  version: Schema.Int,
  storageKey: Schema.NullOr(Schema.String),
  sizeBytes: Schema.Number,
  mimeType: Schema.NullOr(Schema.String),
  runThreadId: Schema.NullOr(Schema.String),
  runRef: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
type ArtifactRow = typeof ArtifactRow.Type;

export const TeamArtifactRun = Schema.Struct({
  threadId: Schema.String.check(Schema.isMaxLength(256)),
  ref: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
export type TeamArtifactRun = typeof TeamArtifactRun.Type;

// The member-facing shape. storageKey and sourceUrl stay server-side on purpose:
// one is a host path, the other can carry an upstream bearer credential.
export const TeamArtifact = Schema.Struct({
  id: TeamArtifactId,
  workspaceId: Schema.String,
  projectId: ProjectId,
  ownerUserId: Schema.NullOr(Schema.String),
  ownerName: Schema.NullOr(Schema.String),
  name: Schema.String,
  visibility: TeamArtifactVisibility,
  version: Schema.Int,
  sizeBytes: Schema.Number,
  mimeType: Schema.NullOr(Schema.String),
  run: Schema.NullOr(TeamArtifactRun),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type TeamArtifact = typeof TeamArtifact.Type;

export interface TeamArtifactPublishInput {
  readonly id?: string;
  readonly name: string;
  readonly visibility?: TeamArtifactVisibility;
  readonly mimeType?: string;
  readonly run?: TeamArtifactRun;
  readonly sourceUrl?: string;
  readonly content?: Uint8Array;
}

export interface TeamArtifactImportEntry {
  readonly id: string;
  readonly name?: string;
  readonly version?: number;
  readonly ownerUserId?: string;
  readonly visibility?: TeamArtifactVisibility;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly sourceUrl?: string;
  readonly runThreadId?: string;
  readonly runRef?: string;
}

export const TeamArtifactImportPlan = Schema.Struct({
  received: Schema.Int,
  wouldCreate: Schema.Array(Schema.Struct({ id: Schema.String, version: Schema.Int })),
  conflicts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      incomingVersion: Schema.Int,
      existingVersion: Schema.Int,
    }),
  ),
  invalid: Schema.Array(
    Schema.Struct({ index: Schema.Int, id: Schema.NullOr(Schema.String), reason: Schema.String }),
  ),
});
export type TeamArtifactImportPlan = typeof TeamArtifactImportPlan.Type;

export interface TeamArtifactContent {
  readonly path: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly download?: boolean;
}

export class TeamArtifactError extends Schema.TaggedError<TeamArtifactError>()(
  "TeamArtifactError",
  {
    rule: Schema.Literals([
      "artifact_exists",
      "artifact_not_found",
      "artifact_content_unavailable",
      "artifact_input_invalid",
      "viewer_write_denied",
      "import_manifest_invalid",
    ]),
  },
) {
  override get message(): string {
    return this.rule;
  }
}

export type StoreError =
  | TeamArtifactError
  | TeamMembershipError
  | PersistenceSqlError
  | PersistenceDecodeError;

const SELECT_ARTIFACT = `
  SELECT a.id, a.workspace_id AS "workspaceId", a.project_id AS "projectId",
         a.owner_user_id AS "ownerUserId", u.name AS "ownerName",
         a.name, a.visibility, a.version, a.storage_key AS "storageKey", a.size_bytes AS "sizeBytes",
         a.mime_type AS "mimeType", a.run_thread_id AS "runThreadId", a.run_ref AS "runRef",
         a.created_at AS "createdAt", a.updated_at AS "updatedAt"
  FROM team_artifacts a LEFT JOIN team_users u ON u.id = a.owner_user_id`;

const toView = (row: ArtifactRow): TeamArtifact => ({
  id: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  ownerUserId: row.ownerUserId,
  ownerName: row.ownerName,
  name: row.name,
  visibility: row.visibility,
  version: row.version,
  sizeBytes: row.sizeBytes,
  mimeType: row.mimeType,
  run:
    row.runThreadId === null
      ? null
      : { threadId: row.runThreadId, ...(row.runRef === null ? {} : { ref: row.runRef }) },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const decodeRows = <A>(
  decode: (input: unknown) => Effect.Effect<ReadonlyArray<A>, Schema.SchemaError>,
  operation: string,
) =>
  Effect.flatMap((rows: unknown) =>
    decode(rows).pipe(
      Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)),
    ),
  );

export class TeamArtifactRepository extends Context.Service<
  TeamArtifactRepository,
  {
    readonly publish: (
      subject: string,
      workspaceId: string,
      input: TeamArtifactPublishInput,
    ) => Effect.Effect<TeamArtifact, StoreError>;
    readonly list: (
      subject: string,
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<TeamArtifact>, StoreError>;
    readonly detail: (
      subject: string,
      workspaceId: string,
      artifactId: string,
    ) => Effect.Effect<TeamArtifact, StoreError>;
    readonly openContent: (
      subject: string,
      workspaceId: string,
      artifactId: string,
      disposition: "inline" | "download",
    ) => Effect.Effect<TeamArtifactContent, StoreError>;
    readonly setVisibility: (
      subject: string,
      workspaceId: string,
      artifactId: string,
      visibility: TeamArtifactVisibility,
    ) => Effect.Effect<TeamArtifact, StoreError>;
    /** Dry-run only: reads state, plans every entry, writes nothing, safe to interrupt. */
    readonly importDryRun: (
      subject: string,
      workspaceId: string,
      entries: ReadonlyArray<TeamArtifactImportEntry>,
    ) => Effect.Effect<TeamArtifactImportPlan, StoreError>;
  }
>()("t3/team/TeamArtifacts/TeamArtifactRepository") {}

const decodeArtifacts = Schema.decodeUnknownEffect(Schema.Array(ArtifactRow));
// better-sqlite3 reports SQLITE_CONSTRAINT_PRIMARYKEY (1555) and
// SQLITE_CONSTRAINT_UNIQUE (2067) as numeric errcode fields on the cause chain.
const isUniqueViolation = (cause: unknown) => {
  let value = cause;
  for (let depth = 0; depth < 4 && typeof value === "object" && value !== null; depth += 1) {
    if ("errcode" in value && (value.errcode === 1555 || value.errcode === 2067)) {
      return true;
    }
    value = "cause" in value ? value.cause : undefined;
  }
  return false;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const members = yield* TeamMembershipRepository;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const artifactsDir = path.join(config.stateDir, "team-artifacts");

  const sqlError = (operation: string) =>
    toPersistenceSqlError(`TeamArtifactRepository.${operation}`);

  const requireWriteRole = Effect.fn("TeamArtifactRepository.requireWriteRole")(function* (
    subject: string,
    workspaceId: string,
  ) {
    const access = yield* members.resolve(subject, workspaceId);
    if (access.role === "Viewer") {
      return yield* new TeamArtifactError({ rule: "viewer_write_denied" });
    }
    return access;
  });

  const findReadable = Effect.fn("TeamArtifactRepository.findReadable")(function* (
    subject: string,
    workspaceId: string,
    artifactId: string,
  ) {
    const access = yield* members.resolve(subject, workspaceId);
    // Mode W: workspace-shared rows with a live owner, plus the caller's own
    // private rows. An owner id no live user holds never matches, so
    // unknown-owner rows stay private.
    const rows = yield* sql`
      ${sql.literal(SELECT_ARTIFACT)}
      WHERE a.workspace_id = ${workspaceId} AND a.id = ${artifactId}
        AND (
          a.owner_user_id = ${access.userId}
          OR (a.visibility = 'workspace' AND a.owner_user_id IN (SELECT id FROM team_users))
        )
    `.pipe(
      Effect.mapError(sqlError("findReadable")),
      decodeRows(decodeArtifacts, "TeamArtifactRepository.findReadable"),
    );
    if (!rows[0]) return yield* new TeamArtifactError({ rule: "artifact_not_found" });
    return { access, row: rows[0] };
  });

  const publish = Effect.fn("TeamArtifactRepository.publish")(function* (
    subject: string,
    workspaceId: string,
    input: TeamArtifactPublishInput,
  ) {
    const access = yield* requireWriteRole(subject, workspaceId);
    const id = input.id ?? `art_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    const name = input.name.trim();
    const content = input.content;
    const sourceUrl = input.sourceUrl?.trim() || null;
    if (
      !TEAM_ARTIFACT_ID_PATTERN.test(id) ||
      name.length === 0 ||
      name.length > 256 ||
      ((content === undefined || content.byteLength === 0) && sourceUrl === null)
    ) {
      return yield* new TeamArtifactError({ rule: "artifact_input_invalid" });
    }
    const storageKey =
      content === undefined ? null : `${workspaceId}/${id}${attachmentFileExtension(name)}`;
    const now = yield* Clock.currentTimeMillis;

    if (content !== undefined && storageKey !== null) {
      // Stage bytes under a unique .part name, then publish with one rename: a
      // reader never sees a partial file and an interrupted write drops only .part.
      const finalPath = resolveAttachmentRelativePath({
        attachmentsDir: artifactsDir,
        relativePath: storageKey,
      });
      const partPath = resolveAttachmentRelativePath({
        attachmentsDir: artifactsDir,
        relativePath: `${storageKey}.${NodeCrypto.randomUUID()}.part`,
      });
      if (finalPath === null || partPath === null) {
        return yield* new TeamArtifactError({ rule: "artifact_input_invalid" });
      }
      yield* fileSystem
        .makeDirectory(path.dirname(finalPath), { recursive: true })
        .pipe(
          Effect.andThen(Stream.run(Stream.make(content), fileSystem.sink(partPath))),
          Effect.andThen(fileSystem.rename(partPath, finalPath)),
          Effect.mapError(sqlError("publishStorage")),
          Effect.ensuring(
            fileSystem.remove(partPath, { force: true }).pipe(Effect.orElseSucceed(() => {})),
          ),
        );
    }

    yield* sql`
      INSERT INTO team_artifacts
        (id, workspace_id, project_id, owner_user_id, name, visibility, version, storage_key,
         size_bytes, mime_type, source_url, run_thread_id, run_ref, created_at, updated_at)
      VALUES (${id}, ${workspaceId}, ${access.projectId}, ${access.userId}, ${name},
              ${input.visibility ?? "workspace"}, 1, ${storageKey}, ${content?.byteLength ?? 0},
              ${input.mimeType?.trim() || null}, ${sourceUrl}, ${input.run?.threadId ?? null},
              ${input.run?.ref ?? null}, ${now}, ${now})
    `.pipe(
      Effect.mapError((cause) =>
        isUniqueViolation(cause)
          ? new TeamArtifactError({ rule: "artifact_exists" })
          : sqlError("publish")(cause),
      ),
      Effect.tapError(() =>
        storageKey === null
          ? Effect.void
          : fileSystem
              .remove(
                resolveAttachmentRelativePath({
                  attachmentsDir: artifactsDir,
                  relativePath: storageKey,
                }) ?? path.join(artifactsDir, ".unreachable"),
                { force: true },
              )
              .pipe(Effect.orElseSucceed(() => {})),
      ),
    );

    const { row } = yield* findReadable(subject, workspaceId, id);
    return toView(row);
  });

  const list = Effect.fn("TeamArtifactRepository.list")(function* (
    subject: string,
    workspaceId: string,
  ) {
    const access = yield* members.resolve(subject, workspaceId);
    const rows = yield* sql`
      ${sql.literal(SELECT_ARTIFACT)}
      WHERE a.workspace_id = ${workspaceId}
        AND (
          a.owner_user_id = ${access.userId}
          OR (a.visibility = 'workspace' AND a.owner_user_id IN (SELECT id FROM team_users))
        )
      ORDER BY a.id
    `.pipe(
      Effect.mapError(sqlError("list")),
      decodeRows(decodeArtifacts, "TeamArtifactRepository.list"),
    );
    return rows.map(toView);
  });

  const detail = Effect.fn("TeamArtifactRepository.detail")(function* (
    subject: string,
    workspaceId: string,
    artifactId: string,
  ) {
    const { row } = yield* findReadable(subject, workspaceId, artifactId);
    return toView(row);
  });

  const openContent = Effect.fn("TeamArtifactRepository.openContent")(function* (
    subject: string,
    workspaceId: string,
    artifactId: string,
    disposition: "inline" | "download",
  ) {
    const { row } = yield* findReadable(subject, workspaceId, artifactId);
    // Content is served only from the local store: never redirect to source_url,
    // which can carry an upstream bearer credential that would bypass the ACL.
    if (row.storageKey === null) {
      return yield* new TeamArtifactError({ rule: "artifact_content_unavailable" });
    }
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir: artifactsDir,
      relativePath: row.storageKey,
    });
    const exists =
      filePath !== null &&
      (yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false)));
    if (!exists || filePath === null) {
      return yield* new TeamArtifactError({ rule: "artifact_content_unavailable" });
    }
    return {
      path: filePath,
      fileName: row.name,
      ...(row.mimeType === null ? {} : { mimeType: row.mimeType }),
      ...(disposition === "download" ? { download: true } : {}),
    } satisfies TeamArtifactContent;
  });

  const setVisibility = Effect.fn("TeamArtifactRepository.setVisibility")(function* (
    subject: string,
    workspaceId: string,
    artifactId: string,
    visibility: TeamArtifactVisibility,
  ) {
    const access = yield* members.resolve(subject, workspaceId);
    if (access.role !== "Owner") {
      return yield* new TeamMembershipError({ rule: "owner_required" });
    }
    const now = yield* Clock.currentTimeMillis;
    // The owner-known guard keeps an unknown-owner row private for good.
    const updated = yield* sql`
      UPDATE team_artifacts SET visibility = ${visibility}, version = version + 1, updated_at = ${now}
      WHERE workspace_id = ${workspaceId} AND id = ${artifactId}
        AND owner_user_id IN (SELECT id FROM team_users)
      RETURNING id
    `.pipe(Effect.mapError(sqlError("setVisibility")));
    if (updated.length === 0) {
      return yield* new TeamArtifactError({ rule: "artifact_not_found" });
    }
    // Re-read under the same owner-known guard the UPDATE used: the Owner may
    // have just written a row it cannot otherwise read (e.g. another member's
    // private artifact), and the write already committed.
    const rows = yield* sql`
      ${sql.literal(SELECT_ARTIFACT)}
      WHERE a.workspace_id = ${workspaceId} AND a.id = ${artifactId}
        AND a.owner_user_id IN (SELECT id FROM team_users)
    `.pipe(
      Effect.mapError(sqlError("setVisibility")),
      decodeRows(decodeArtifacts, "TeamArtifactRepository.setVisibility"),
    );
    if (!rows[0]) return yield* new TeamArtifactError({ rule: "artifact_not_found" });
    return toView(rows[0]);
  });

  const importDryRun = Effect.fn("TeamArtifactRepository.importDryRun")(function* (
    subject: string,
    workspaceId: string,
    entries: ReadonlyArray<TeamArtifactImportEntry>,
  ) {
    yield* requireWriteRole(subject, workspaceId);
    const existing = yield* sql`
      SELECT id, version FROM team_artifacts WHERE workspace_id = ${workspaceId}
    `.pipe(Effect.mapError(sqlError("importDryRun")));
    const existingVersions = new Map(
      (existing as ReadonlyArray<{ id: string; version: number }>).map((row) => [
        row.id,
        row.version,
      ]),
    );

    const plan = {
      received: entries.length,
      wouldCreate: [] as TeamArtifactImportPlan["wouldCreate"][number][],
      conflicts: [] as TeamArtifactImportPlan["conflicts"][number][],
      invalid: [] as TeamArtifactImportPlan["invalid"][number][],
    };
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const id = typeof entry?.id === "string" ? entry.id : null;
      const version = entry?.version === undefined ? 1 : Math.trunc(entry.version);
      const invalid = (reason: string) => plan.invalid.push({ index, id, reason });
      if (id === null || !TEAM_ARTIFACT_ID_PATTERN.test(id)) {
        invalid("id_invalid");
        continue;
      }
      if (seen.has(id)) {
        invalid("id_duplicate");
        continue;
      }
      seen.add(id);
      if (!Number.isInteger(version) || version < 1) {
        invalid("version_invalid");
        continue;
      }
      if (
        entry.name !== undefined &&
        (typeof entry.name !== "string" || entry.name.length === 0 || entry.name.length > 256)
      ) {
        invalid("name_invalid");
        continue;
      }
      if (
        entry.visibility !== undefined &&
        entry.visibility !== "workspace" &&
        entry.visibility !== "private"
      ) {
        invalid("visibility_invalid");
        continue;
      }
      const existingVersion = existingVersions.get(id);
      if (existingVersion !== undefined) {
        plan.conflicts.push({ id, incomingVersion: version, existingVersion });
        continue;
      }
      plan.wouldCreate.push({ id, version });
    }
    if (plan.received > 0 && plan.invalid.length === plan.received) {
      return yield* new TeamArtifactError({ rule: "import_manifest_invalid" });
    }
    return plan;
  });

  return TeamArtifactRepository.of({
    publish,
    list,
    detail,
    openContent,
    setVisibility,
    importDryRun,
  });
});

export const layer = Layer.effect(TeamArtifactRepository, make);
