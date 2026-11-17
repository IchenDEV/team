import {
  ModelSelection,
  ProjectId,
  TeamError,
  TeamId,
  TeamRpcGroup,
  TeamWorkspaceAccess,
  TeamMember,
  TeamRole,
  type AuthAccessTokenResult,
  type AuthSessionId,
  type TeamReadInput,
  type TeamRun,
  type TeamStartInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type { ManagedPolicyRefusedError } from "../policy/managedLimits.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import {
  TeamExecutionBoundary,
  scopedRunId,
  type SandboxWorkspace,
} from "./TeamExecutionBoundary.ts";

const isTeamError = Schema.is(TeamError);
const Workspace = Schema.Struct({
  id: TeamId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  rpcUrl: Schema.String,
  bearer: Schema.String.check(Schema.isMinLength(32)),
  // Restricted credential scope injected into this workspace's sandbox only;
  // never shared across tenants. networkMode defaults to a fully cut network.
  credentials: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  networkMode: Schema.optional(Schema.Literals(["none", "bridge"])),
});
// Runs execute in a per-workspace container sandbox under this state directory;
// when it is absent the boundary fails closed instead of falling back to the host.
export const TeamConfig = Schema.Struct({
  workspaces: Schema.Array(Workspace),
  sandboxStateDir: Schema.optional(Schema.String),
});
export type TeamConfig = typeof TeamConfig.Type;
export const userSubject = (id: string) => `team:user:${id}`;

type Access = typeof TeamWorkspaceAccess.Type;
type Role = typeof TeamRole.Type;
export class TeamControlPlane extends Context.Service<
  TeamControlPlane,
  {
    readonly login: (credential: string) => Effect.Effect<AuthAccessTokenResult, TeamError>;
    readonly logout: (authorization: string | undefined) => Effect.Effect<void, TeamError>;
    readonly workspaces: (
      authorization: string | undefined,
    ) => Effect.Effect<ReadonlyArray<Access>, TeamError>;
    readonly workspace: (
      authorization: string | undefined,
      workspaceId: string,
    ) => Effect.Effect<Access, TeamError>;
    readonly createWorkspace: (
      authorization: string | undefined,
      workspaceId: string,
      name: string,
    ) => Effect.Effect<void, TeamError>;
    readonly renameWorkspace: (
      authorization: string | undefined,
      workspaceId: string,
      name: string,
    ) => Effect.Effect<void, TeamError>;
    readonly deleteWorkspace: (
      authorization: string | undefined,
      workspaceId: string,
    ) => Effect.Effect<void, TeamError>;
    readonly members: (
      authorization: string | undefined,
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<typeof TeamMember.Type>, TeamError>;
    readonly invite: (
      authorization: string | undefined,
      input: {
        readonly workspaceId: string;
        readonly userId: string;
        readonly name: string;
        readonly role: Role;
      },
    ) => Effect.Effect<{ readonly credential: string }, TeamError>;
    readonly setMember: (
      authorization: string | undefined,
      workspaceId: string,
      userId: string,
      role: Role,
    ) => Effect.Effect<void, TeamError>;
    readonly removeMember: (
      authorization: string | undefined,
      workspaceId: string,
      userId: string,
    ) => Effect.Effect<void, TeamError>;
    readonly start: (
      authorization: string | undefined,
      input: TeamStartInput,
    ) => Effect.Effect<TeamRun, TeamError>;
    readonly read: (
      authorization: string | undefined,
      input: TeamReadInput,
    ) => Effect.Effect<TeamRun, TeamError>;
    readonly stream: (
      authorization: string | undefined,
      input: TeamReadInput,
    ) => Stream.Stream<TeamRun, TeamError>;
  }
>()("t3/team/TeamControlPlane") {}

const sandboxWorkspace = (workspace: typeof Workspace.Type): SandboxWorkspace => ({
  id: workspace.id,
  credentials: workspace.credentials ?? {},
  networkMode: workspace.networkMode ?? "none",
});

// Every sandbox failure fails closed on the Team surface: an unavailable or
// revoked boundary never degrades into host execution.
const sandboxErrors = {
  SandboxRunNotFound: () => new TeamError({ rule: "run_not_found" as const }),
  SandboxRunConflict: () => new TeamError({ rule: "command_conflict" as const }),
  SandboxRevoked: () => new TeamError({ rule: "workspace_membership_required" as const }),
  SandboxUnavailable: () => new TeamError({ rule: "executor_failure" as const }),
};

const storage = <A>(
  effect: Effect.Effect<
    A,
    TeamMemberships.TeamMembershipError | PersistenceSqlError | PersistenceDecodeError
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      TeamMembershipError: (error) => Effect.fail(new TeamError({ rule: error.rule })),
      PersistenceSqlError: (cause) =>
        Effect.logError("Team storage failed", { cause }).pipe(
          Effect.andThen(Effect.fail(new TeamError({ rule: "storage_failure" }))),
        ),
      PersistenceDecodeError: (cause) =>
        Effect.logError("Team storage decode failed", { cause }).pipe(
          Effect.andThen(Effect.fail(new TeamError({ rule: "storage_failure" }))),
        ),
    }),
  );
const authFailure = (
  cause:
    | EnvironmentAuth.ServerAuthCredentialError
    | EnvironmentAuth.ServerAuthInternalError
    | EnvironmentAuth.ServerAuthInvalidRequestError
    | EnvironmentAuth.ServerAuthConnectApprovalPendingError
    | ManagedPolicyRefusedError,
) =>
  EnvironmentAuth.isServerAuthCredentialError(cause) ||
  cause._tag === "ServerAuthInvalidScopeError" ||
  cause._tag === "ServerAuthScopeNotGrantedError" ||
  cause._tag === "ServerAuthConnectApprovalPendingError"
    ? Effect.fail(new TeamError({ rule: "authentication_required" }))
    : Effect.logError("Team environment authentication failed", { cause }).pipe(
        Effect.andThen(Effect.fail(new TeamError({ rule: "storage_failure" }))),
      );

export const layer = (config: TeamConfig) =>
  Layer.effect(
    TeamControlPlane,
    Effect.gen(function* () {
      const members = yield* TeamMemberships.TeamMembershipRepository;
      const sessions = yield* SessionStore.SessionStore;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sql = yield* SqlClient.SqlClient;
      const boundary = yield* TeamExecutionBoundary;
      const verificationFailure = (cause: SessionStore.SessionCredentialError) =>
        SessionStore.isSessionCredentialInvalidError(cause)
          ? Effect.fail(new TeamError({ rule: "authentication_required" }))
          : Effect.logError("Team session verification failed", { cause }).pipe(
              Effect.andThen(Effect.fail(new TeamError({ rule: "storage_failure" }))),
            );
      const verifySession = Effect.fn("TeamControlPlane.verifySession")(function* (
        authorization: string | undefined,
      ) {
        if (!authorization?.startsWith("Bearer "))
          return yield* new TeamError({ rule: "authentication_required" });
        return yield* sessions
          .verify(authorization.slice(7))
          .pipe(Effect.catch(verificationFailure));
      });
      const admit = Effect.fn("TeamControlPlane.admit")(function* (
        session: SessionStore.VerifiedSession,
      ) {
        // DPoP needs a verified proof, and MCP has its own audience; this bearer-only gateway cannot accept either.
        if (session.method !== "bearer-access-token" || session.subject === "mcp-client")
          return yield* new TeamError({ rule: "authentication_required" });
        return session;
      });
      const authenticate = Effect.fn("TeamControlPlane.authenticate")(function* (
        authorization: string | undefined,
      ) {
        return yield* admit(yield* verifySession(authorization));
      });
      const discardSession = (sessionId: AuthSessionId) =>
        sessions
          .delete(sessionId)
          .pipe(
            Effect.catch((cause) =>
              Effect.logError("Team login session cleanup failed", { cause }),
            ),
          );
      // A token this login just received still names its row when verification rejects it.
      const discardIssuedSession = (cause: SessionStore.SessionCredentialError) =>
        "sessionId" in cause && cause.sessionId !== undefined
          ? discardSession(cause.sessionId)
          : Effect.void;
      const authorize = Effect.fn("TeamControlPlane.authorize")(function* (
        authorization: string | undefined,
        workspaceId: string,
        execute = false,
      ) {
        const session = yield* authenticate(authorization);
        const access = yield* storage(members.resolve(session.subject, workspaceId));
        const workspace = config.workspaces.find(
          (entry) => entry.id === access.id && entry.projectId === access.projectId,
        );
        if (!workspace) return yield* new TeamError({ rule: "workspace_not_configured" });
        if (execute && access.role === "Viewer")
          return yield* new TeamError({ rule: "viewer_execution_forbidden" });
        return { session, access, workspace };
      });
      const owner = Effect.fn("TeamControlPlane.owner")(function* (
        authorization: string | undefined,
        workspaceId: string,
      ) {
        const result = yield* authorize(authorization, workspaceId);
        if (result.access.role !== "Owner") return yield* new TeamError({ rule: "owner_required" });
        return result;
      });
      const readRun = Effect.fn("TeamControlPlane.readRun")(function* (
        workspace: typeof Workspace.Type,
        id: string,
      ) {
        if (!scopedRunId(workspace.id, id)) return yield* new TeamError({ rule: "run_not_found" });
        return yield* boundary
          .read(sandboxWorkspace(workspace), id)
          .pipe(Effect.catchTags(sandboxErrors));
      });
      const read = Effect.fn("TeamControlPlane.read")(function* (
        authorization: string | undefined,
        input: TeamReadInput,
      ) {
        const { workspace } = yield* authorize(authorization, input.workspaceId);
        return yield* readRun(workspace, input.runId);
      });

      return TeamControlPlane.of({
        login: Effect.fn("TeamControlPlane.login")(function* (credential) {
          const token = yield* auth
            .exchangeBootstrapCredentialForAccessToken(credential, undefined, {
              deviceType: "unknown",
            })
            .pipe(Effect.catch(authFailure));
          // The exchange already wrote the session row, so every check below that rejects this
          // login must drop it; a revoked row would still hold the subject until its TTL.
          const session = yield* sessions
            .verify(token.access_token)
            .pipe(
              Effect.catch((cause) =>
                discardIssuedSession(cause).pipe(Effect.andThen(verificationFailure(cause))),
              ),
            );
          yield* admit(session).pipe(
            Effect.andThen(storage(members.listWorkspaces(session.subject))),
            Effect.onError(() => discardSession(session.sessionId)),
          );
          return token;
        }),
        logout: Effect.fn("TeamControlPlane.logout")(function* (authorization) {
          const session = yield* authenticate(authorization);
          yield* auth.revokeSession(session.sessionId).pipe(Effect.catch(authFailure));
        }),
        workspaces: Effect.fn("TeamControlPlane.workspaces")(function* (authorization) {
          const session = yield* authenticate(authorization);
          return yield* storage(members.listWorkspaces(session.subject));
        }),
        workspace: Effect.fn("TeamControlPlane.workspace")(function* (authorization, workspaceId) {
          return (yield* authorize(authorization, workspaceId)).access;
        }),
        createWorkspace: Effect.fn("TeamControlPlane.createWorkspace")(
          function* (authorization, workspaceId, name) {
            const session = yield* authenticate(authorization);
            const current = yield* storage(members.listWorkspaces(session.subject));
            if (!current.some((entry) => entry.role === "Owner"))
              return yield* new TeamError({ rule: "owner_required" });
            const workspace = config.workspaces.find((entry) => entry.id === workspaceId);
            if (!workspace) return yield* new TeamError({ rule: "workspace_not_configured" });
            yield* storage(
              members.createWorkspace(session.subject, {
                id: workspace.id,
                projectId: workspace.projectId,
                name,
              }),
            );
          },
        ),
        renameWorkspace: Effect.fn("TeamControlPlane.renameWorkspace")(
          function* (authorization, workspaceId, name) {
            const { session } = yield* owner(authorization, workspaceId);
            yield* storage(members.renameWorkspace(session.subject, workspaceId, name));
          },
        ),
        deleteWorkspace: Effect.fn("TeamControlPlane.deleteWorkspace")(
          function* (authorization, workspaceId) {
            const { session } = yield* owner(authorization, workspaceId);
            // Revoke at the boundary before membership rows settle: the durable
            // marker blocks in-flight and later starts, and if membership
            // deletion then fails the workspace stays denied rather than live.
            yield* boundary.dropWorkspace(workspaceId).pipe(Effect.catchTags(sandboxErrors));
            yield* storage(members.deleteWorkspace(session.subject, workspaceId));
          },
        ),
        members: Effect.fn("TeamControlPlane.members")(function* (authorization, workspaceId) {
          const { session } = yield* authorize(authorization, workspaceId);
          return yield* storage(members.listMembers(session.subject, workspaceId));
        }),
        invite: Effect.fn("TeamControlPlane.invite")(function* (authorization, input) {
          const { session } = yield* owner(authorization, input.workspaceId);
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* storage(
                  members.inviteUser({
                    id: input.userId,
                    subject: userSubject(input.userId),
                    name: input.name,
                  }),
                );
                yield* storage(
                  members.setMember(session.subject, input.workspaceId, input.userId, input.role),
                );
                const invitation = yield* auth
                  .createPairingLink({
                    subject: userSubject(input.userId),
                    scopes: ["orchestration:read"],
                  })
                  .pipe(Effect.catch(authFailure));
                return { credential: invitation.credential };
              }),
            )
            .pipe(
              Effect.catchTags({
                SqlError: (cause) =>
                  Effect.logError("Team invitation transaction failed", { cause }).pipe(
                    Effect.andThen(Effect.fail(new TeamError({ rule: "storage_failure" }))),
                  ),
              }),
            );
        }),
        setMember: Effect.fn("TeamControlPlane.setMember")(
          function* (authorization, workspaceId, userId, role) {
            const { session } = yield* owner(authorization, workspaceId);
            yield* storage(members.setMember(session.subject, workspaceId, userId, role));
          },
        ),
        removeMember: Effect.fn("TeamControlPlane.removeMember")(
          function* (authorization, workspaceId, userId) {
            const { session } = yield* owner(authorization, workspaceId);
            yield* storage(members.removeMember(session.subject, workspaceId, userId));
          },
        ),
        start: Effect.fn("TeamControlPlane.start")(function* (authorization, input) {
          const { access, workspace } = yield* authorize(authorization, input.workspaceId, true);
          const id = `team.${workspace.id}.${access.userId}.${input.commandId}`;
          yield* boundary
            .start(sandboxWorkspace(workspace), id, input.text)
            .pipe(Effect.catchTags(sandboxErrors));
          return yield* readRun(workspace, id);
        }),
        read,
        stream: (authorization, input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const { session, workspace } = yield* authorize(authorization, input.workspaceId);
              yield* readRun(workspace, input.runId);
              return Stream.fromEffect(readRun(workspace, input.runId)).pipe(
                Stream.repeat(Schedule.spaced("500 millis")),
                Stream.takeUntil((run) => run.status !== "running" && run.status !== "waiting"),
                Stream.mapError((cause) =>
                  isTeamError(cause) ? cause : new TeamError({ rule: "executor_failure" }),
                ),
                Stream.interruptWhen(
                  Effect.raceFirst(
                    sessions.awaitInvalidation(session.sessionId).pipe(
                      Effect.tapError((cause) =>
                        Effect.logError("Team session invalidation failed", { cause }),
                      ),
                      Effect.mapError(() => new TeamError({ rule: "storage_failure" })),
                      Effect.andThen(
                        Effect.fail(new TeamError({ rule: "authentication_required" })),
                      ),
                    ),
                    storage(members.awaitRevocation(session.subject, input.workspaceId)),
                  ),
                ),
              );
            }),
          ),
      });
    }),
  );

export const handlers = TeamRpcGroup.toLayer(
  Effect.gen(function* () {
    const team = yield* TeamControlPlane;
    return {
      "team.login": (input) => team.login(input.credential),
      "team.logout": (_, { headers }) => team.logout(headers.authorization),
      "team.workspaces": (_, { headers }) => team.workspaces(headers.authorization),
      "team.workspace": (input, { headers }) =>
        team.workspace(headers.authorization, input.workspaceId),
      "team.createWorkspace": (input, { headers }) =>
        team.createWorkspace(headers.authorization, input.workspaceId, input.name),
      "team.renameWorkspace": (input, { headers }) =>
        team.renameWorkspace(headers.authorization, input.workspaceId, input.name),
      "team.deleteWorkspace": (input, { headers }) =>
        team.deleteWorkspace(headers.authorization, input.workspaceId),
      "team.members": (input, { headers }) =>
        team.members(headers.authorization, input.workspaceId),
      "team.invite": (input, { headers }) => team.invite(headers.authorization, input),
      "team.setMember": (input, { headers }) =>
        team.setMember(headers.authorization, input.workspaceId, input.userId, input.role),
      "team.removeMember": (input, { headers }) =>
        team.removeMember(headers.authorization, input.workspaceId, input.userId),
      "team.start": (input, { headers }) => team.start(headers.authorization, input),
      "team.read": (input, { headers }) => team.read(headers.authorization, input),
      "team.stream": (input, { headers }) => team.stream(headers.authorization, input),
    };
  }),
);
