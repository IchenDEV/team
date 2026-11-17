import { TeamWorkspace, TeamWorkspaceAccess, TeamMember, TeamRole } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceDecodeError, PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

const User = Schema.Struct({ id: Schema.String, subject: Schema.String, name: Schema.String });
const Workspace = TeamWorkspace;
const Role = TeamRole;
const Membership = TeamMember;
const Access = TeamWorkspaceAccess;

export class TeamMembershipError extends Schema.TaggedError<TeamMembershipError>()(
  "TeamMembershipError",
  {
    rule: Schema.Literals([
      "invited_user_required",
      "workspace_membership_required",
      "owner_required",
      "last_owner_required",
      "member_not_found",
    ]),
  },
) {}

type StoreError = TeamMembershipError | PersistenceSqlError | PersistenceDecodeError;

// Subjects come only from the existing verified environment session, never from an RPC payload.
export class TeamMembershipRepository extends Context.Service<
  TeamMembershipRepository,
  {
    readonly awaitRevocation: (
      subject: string,
      workspaceId: string,
    ) => Effect.Effect<never, StoreError>;
    readonly inviteUser: (input: typeof User.Type) => Effect.Effect<void, StoreError>;
    readonly createWorkspace: (
      subject: string,
      input: typeof Workspace.Type,
    ) => Effect.Effect<void, StoreError>;
    readonly listWorkspaces: (
      subject: string,
    ) => Effect.Effect<ReadonlyArray<typeof Access.Type>, StoreError>;
    readonly resolve: (
      subject: string,
      workspaceId: string,
    ) => Effect.Effect<typeof Access.Type, StoreError>;
    readonly renameWorkspace: (
      subject: string,
      workspaceId: string,
      name: string,
    ) => Effect.Effect<void, StoreError>;
    readonly deleteWorkspace: (
      subject: string,
      workspaceId: string,
    ) => Effect.Effect<void, StoreError>;
    readonly listMembers: (
      subject: string,
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<typeof Membership.Type>, StoreError>;
    readonly setMember: (
      subject: string,
      workspaceId: string,
      userId: string,
      role: typeof Role.Type,
    ) => Effect.Effect<void, StoreError>;
    readonly removeMember: (
      subject: string,
      workspaceId: string,
      userId: string,
    ) => Effect.Effect<void, StoreError>;
  }
>()("t3/persistence/TeamMemberships/TeamMembershipRepository") {}

const decodeUsers = Schema.decodeUnknownEffect(Schema.Array(User));
const decodeAccess = Schema.decodeUnknownEffect(Schema.Array(Access));
const decodeMemberships = Schema.decodeUnknownEffect(Schema.Array(Membership));

const decodeRows = <A>(
  decode: (input: unknown) => Effect.Effect<ReadonlyArray<A>, Schema.SchemaError>,
  operation: string,
) =>
  Effect.flatMap((rows: unknown) =>
    decode(rows).pipe(
      Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<string>();
  const transaction = <A>(operation: string, effect: Effect.Effect<A, StoreError>) =>
    sql.withTransaction(effect).pipe(
      Effect.catchTags({
        SqlError: (cause) => Effect.fail(toPersistenceSqlError(operation)(cause)),
      }),
    );
  const requireUser = Effect.fn("TeamMembershipRepository.requireUser")(function* (
    subject: string,
  ) {
    const rows =
      yield* sql`SELECT id, subject, name FROM team_users WHERE subject = ${subject}`.pipe(
        Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.requireUser")),
        decodeRows(decodeUsers, "TeamMembershipRepository.requireUser"),
      );
    if (!rows[0]) return yield* new TeamMembershipError({ rule: "invited_user_required" });
    return rows[0];
  });
  const listWorkspaces = Effect.fn("TeamMembershipRepository.listWorkspaces")(function* (
    subject: string,
  ) {
    const user = yield* requireUser(subject);
    return yield* sql`
      SELECT w.id, w.project_id AS "projectId", w.name, m.user_id AS "userId", m.role
      FROM team_workspaces w JOIN team_memberships m ON m.workspace_id = w.id
      WHERE m.user_id = ${user.id} ORDER BY w.id
    `.pipe(
      Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.listWorkspaces")),
      decodeRows(decodeAccess, "TeamMembershipRepository.listWorkspaces"),
    );
  });
  const resolve = Effect.fn("TeamMembershipRepository.resolve")(function* (
    subject: string,
    workspaceId: string,
  ) {
    const user = yield* requireUser(subject);
    const rows = yield* sql`
      SELECT w.id, w.project_id AS "projectId", w.name, m.user_id AS "userId", m.role
      FROM team_workspaces w JOIN team_memberships m ON m.workspace_id = w.id
      WHERE w.id = ${workspaceId} AND m.user_id = ${user.id}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.resolve")),
      decodeRows(decodeAccess, "TeamMembershipRepository.resolve"),
    );
    if (!rows[0]) return yield* new TeamMembershipError({ rule: "workspace_membership_required" });
    return rows[0];
  });
  const requireOwner = Effect.fn("TeamMembershipRepository.requireOwner")(function* (
    subject: string,
    workspaceId: string,
  ) {
    const access = yield* resolve(subject, workspaceId);
    if (access.role !== "Owner") return yield* new TeamMembershipError({ rule: "owner_required" });
    return access;
  });
  const preserveOwner = Effect.fn("TeamMembershipRepository.preserveOwner")(function* (
    workspaceId: string,
    userId: string,
  ) {
    const rows = yield* sql`
      SELECT 1 FROM team_memberships
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND role = 'Owner'
        AND (SELECT COUNT(*) FROM team_memberships WHERE workspace_id = ${workspaceId} AND role = 'Owner') = 1
    `.pipe(Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.preserveOwner")));
    if (rows.length > 0) return yield* new TeamMembershipError({ rule: "last_owner_required" });
  });

  return TeamMembershipRepository.of({
    awaitRevocation: Effect.fn("TeamMembershipRepository.awaitRevocation")(function* (
      subject,
      workspaceId,
    ) {
      const subscription = yield* PubSub.subscribe(changes);
      while (true) {
        yield* resolve(subject, workspaceId);
        let changed = yield* PubSub.take(subscription);
        while (changed !== workspaceId) changed = yield* PubSub.take(subscription);
      }
    }, Effect.scoped),
    inviteUser: Effect.fn("TeamMembershipRepository.inviteUser")(function (input) {
      return sql`INSERT INTO team_users (id, subject, name) VALUES (${input.id}, ${input.subject}, ${input.name})
        ON CONFLICT(id) DO UPDATE SET id = excluded.id WHERE team_users.subject = excluded.subject RETURNING id`.pipe(
        Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.inviteUser")),
        Effect.flatMap((rows) =>
          rows.length === 1
            ? Effect.void
            : Effect.fail(new TeamMembershipError({ rule: "invited_user_required" })),
        ),
      );
    }),
    createWorkspace: Effect.fn("TeamMembershipRepository.createWorkspace")(
      function (subject, input) {
        return transaction(
          "TeamMembershipRepository.createWorkspace",
          Effect.gen(function* () {
            const user = yield* requireUser(subject);
            yield* sql`INSERT INTO team_workspaces (id, project_id, name) VALUES (${input.id}, ${input.projectId}, ${input.name})`.pipe(
              Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.createWorkspace")),
            );
            yield* sql`INSERT INTO team_memberships (workspace_id, user_id, role) VALUES (${input.id}, ${user.id}, 'Owner')`.pipe(
              Effect.mapError(
                toPersistenceSqlError("TeamMembershipRepository.createWorkspaceOwner"),
              ),
            );
          }),
        );
      },
    ),
    listWorkspaces,
    resolve,
    renameWorkspace: Effect.fn("TeamMembershipRepository.renameWorkspace")(
      function (subject, workspaceId, name) {
        return transaction(
          "TeamMembershipRepository.renameWorkspace",
          Effect.gen(function* () {
            yield* requireOwner(subject, workspaceId);
            yield* sql`UPDATE team_workspaces SET name = ${name} WHERE id = ${workspaceId}`.pipe(
              Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.renameWorkspace")),
            );
          }),
        );
      },
    ),
    deleteWorkspace: Effect.fn("TeamMembershipRepository.deleteWorkspace")(
      function (subject, workspaceId) {
        return transaction(
          "TeamMembershipRepository.deleteWorkspace",
          Effect.gen(function* () {
            yield* requireOwner(subject, workspaceId);
            // Keep the binding reserved so a new owner cannot inherit retained native runs.
            yield* sql`DELETE FROM team_memberships WHERE workspace_id = ${workspaceId}`.pipe(
              Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.deleteWorkspace")),
            );
          }),
        ).pipe(
          Effect.tap(() => PubSub.publish(changes, workspaceId)),
          Effect.uninterruptible,
        );
      },
    ),
    listMembers: Effect.fn("TeamMembershipRepository.listMembers")(
      function* (subject, workspaceId) {
        yield* resolve(subject, workspaceId);
        return yield* sql`
        SELECT m.user_id AS "userId", u.name, m.role
        FROM team_memberships m JOIN team_users u ON u.id = m.user_id
        WHERE m.workspace_id = ${workspaceId} ORDER BY m.user_id
      `.pipe(
          Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.listMembers")),
          decodeRows(decodeMemberships, "TeamMembershipRepository.listMembers"),
        );
      },
    ),
    setMember: Effect.fn("TeamMembershipRepository.setMember")(
      function (subject, workspaceId, userId, role) {
        return transaction(
          "TeamMembershipRepository.setMember",
          Effect.gen(function* () {
            yield* requireOwner(subject, workspaceId);
            if (role !== "Owner") yield* preserveOwner(workspaceId, userId);
            const users = yield* sql`SELECT id FROM team_users WHERE id = ${userId}`.pipe(
              Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.memberUser")),
            );
            if (users.length === 0)
              return yield* new TeamMembershipError({ rule: "invited_user_required" });
            yield* sql`
          INSERT INTO team_memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, ${role})
          ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role
        `.pipe(Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.setMember")));
          }),
        ).pipe(
          Effect.tap(() => PubSub.publish(changes, workspaceId)),
          Effect.uninterruptible,
        );
      },
    ),
    removeMember: Effect.fn("TeamMembershipRepository.removeMember")(
      function (subject, workspaceId, userId) {
        return transaction(
          "TeamMembershipRepository.removeMember",
          Effect.gen(function* () {
            yield* requireOwner(subject, workspaceId);
            yield* preserveOwner(workspaceId, userId);
            const rows = yield* sql`
          DELETE FROM team_memberships WHERE workspace_id = ${workspaceId} AND user_id = ${userId} RETURNING user_id
        `.pipe(Effect.mapError(toPersistenceSqlError("TeamMembershipRepository.removeMember")));
            if (rows.length === 0)
              return yield* new TeamMembershipError({ rule: "member_not_found" });
          }),
        ).pipe(
          Effect.tap(() => PubSub.publish(changes, workspaceId)),
          Effect.uninterruptible,
        );
      },
    ),
  });
});

export const layer = Layer.effect(TeamMembershipRepository, make);
