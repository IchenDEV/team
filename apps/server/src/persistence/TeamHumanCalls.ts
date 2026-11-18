import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Statement } from "effect/sql/Statement";

import { PersistenceDecodeError, PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

/**
 * A call starts as `accepted`: the gateway reserved the id and issued the one-time
 * input token, but the question has not arrived yet. A valid input file turns it
 * `pending` for the callee; from there it is answered, expired or cancelled.
 */
export const HumanCallState = Schema.Literals([
  "accepted",
  "pending",
  "answered",
  "expired",
  "cancelled",
]);
export type HumanCallState = typeof HumanCallState.Type;
/** What the caller's run receives when the deadline passes. */
export const HumanCallTimeout = Schema.Literals(["expire", "default_answer", "keep_waiting"]);
export type HumanCallTimeout = typeof HumanCallTimeout.Type;

export const HumanCall = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  /** The caller's run id; its member segment is the caller's identity. */
  runId: Schema.String,
  callerUserId: Schema.String,
  calleeUserId: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
  contextLink: Schema.NullOr(Schema.String),
  state: HumanCallState,
  /** One-time input token; present only while the call is accepted. Gateway-private. */
  token: Schema.NullOr(Schema.String),
  onTimeout: HumanCallTimeout,
  defaultAnswer: Schema.NullOr(Schema.String),
  /** Epoch milliseconds; null keeps the call pending until answered or cancelled. */
  expiresAt: Schema.NullOr(Schema.Number),
  raisedAt: Schema.Number,
  settledAt: Schema.NullOr(Schema.Number),
  answer: Schema.NullOr(Schema.String),
  answeredBy: Schema.NullOr(Schema.String),
});
export type HumanCall = typeof HumanCall.Type;

/** A pending call as the callee's inbox shows it: the caller's display name rides along. */
export const HumanCallInInbox = Schema.Struct({
  ...HumanCall.fields,
  callerName: Schema.String,
});
export type HumanCallInInbox = typeof HumanCallInInbox.Type;

export class HumanCallRejected extends Schema.TaggedError<HumanCallRejected>()(
  "HumanCallRejected",
  {
    rule: Schema.Literals([
      "not_found",
      "not_pending",
      "duplicate",
      /** The presented token does not match the reserved one. */
      "invalid_token",
      /** The token was already consumed, or the call already left the accepted state. */
      "token_replayed",
    ]),
  },
) {}

export type StoreError = HumanCallRejected | PersistenceSqlError | PersistenceDecodeError;

/** Rate limits are per caller inside one workspace, checked before a call is accepted. */
export interface HumanCallRateLimits {
  readonly pending: number;
  readonly perHour: number;
}

export interface RaiseHumanCallInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly callerUserId: string;
  readonly calleeUserId: string;
  readonly token: string;
  readonly onTimeout: HumanCallTimeout;
  readonly defaultAnswer: string | null;
  readonly expiresAt: number | null;
  readonly raisedAt: number;
}

/** `options` is one JSON text column, so a row decodes it back into an array. */
const OptionsColumn = Schema.fromJsonString(Schema.Array(Schema.String));
const HumanCallRow = Schema.Struct({ ...HumanCall.fields, options: OptionsColumn });
const HumanCallInboxRow = Schema.Struct({ ...HumanCallInInbox.fields, options: OptionsColumn });
const decodeCalls = Schema.decodeUnknownEffect(Schema.Array(HumanCallRow));
const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(HumanCallInboxRow));

const fields = (prefix: string) => `
  ${prefix}id, ${prefix}workspace_id AS "workspaceId", ${prefix}run_id AS "runId",
  ${prefix}caller_user_id AS "callerUserId", ${prefix}callee_user_id AS "calleeUserId",
  ${prefix}question, ${prefix}options, ${prefix}context_link AS "contextLink", ${prefix}state,
  ${prefix}token, ${prefix}on_timeout AS "onTimeout", ${prefix}default_answer AS "defaultAnswer",
  ${prefix}expires_at AS "expiresAt", ${prefix}raised_at AS "raisedAt",
  ${prefix}settled_at AS "settledAt", ${prefix}answer, ${prefix}answered_by AS "answeredBy"
`;
const columns = fields("");

const encodeOptions = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const decodeRows = <A>(
  decode: (input: unknown) => Effect.Effect<ReadonlyArray<A>, Schema.SchemaError>,
  operation: string,
) =>
  Effect.flatMap((rows: unknown) =>
    decode(rows).pipe(
      Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)),
    ),
  );

export class TeamHumanCallRepository extends Context.Service<
  TeamHumanCallRepository,
  {
    /** Reserves a gateway-generated id and its one-time token; the call starts accepted. */
    readonly raise: (input: RaiseHumanCallInput) => Effect.Effect<HumanCall, StoreError>;
    readonly get: (
      workspaceId: string,
      id: string,
    ) => Effect.Effect<HumanCall | undefined, StoreError>;
    /** Consumes the one-time token and delivers the question; accepted -> pending. */
    readonly activate: (input: {
      readonly workspaceId: string;
      readonly id: string;
      /** The token is bound to this run: another run's input can never activate the call. */
      readonly runId: string;
      readonly token: string;
      readonly question: string;
      readonly options: ReadonlyArray<string>;
      readonly contextLink: string | null;
      readonly at: number;
    }) => Effect.Effect<HumanCall, StoreError>;
    readonly pendingForCallee: (
      workspaceId: string,
      calleeUserId: string,
    ) => Effect.Effect<ReadonlyArray<HumanCallInInbox>, StoreError>;
    readonly pendingInWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    readonly pendingByRun: (runId: string) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    /** Accepted and pending calls of one workspace: the relay reconciles their state files. */
    readonly activeInWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    readonly activeByRun: (runId: string) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    /** Terminal calls settled recently, so a missed state-file delivery is retried. */
    readonly recentlySettled: (
      workspaceId: string,
      since: number,
    ) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    readonly due: (now: number) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    /** The row as it is now, so a slow caller never writes a stale state file. */
    readonly latest: (
      workspaceId: string,
      id: string,
    ) => Effect.Effect<HumanCall | undefined, StoreError>;
    /** Accepted reservations count against the caller's pending quota. */
    readonly countActive: (
      workspaceId: string,
      callerUserId: string,
    ) => Effect.Effect<number, StoreError>;
    readonly countRaisedSince: (
      workspaceId: string,
      callerUserId: string,
      since: number,
    ) => Effect.Effect<number, StoreError>;
    readonly answer: (input: {
      readonly workspaceId: string;
      readonly id: string;
      readonly calleeUserId: string;
      readonly answer: string;
      readonly at: number;
    }) => Effect.Effect<HumanCall, StoreError>;
    readonly settle: (input: {
      readonly workspaceId: string;
      readonly id: string;
      readonly state: Extract<HumanCallState, "expired" | "cancelled">;
      readonly at: number;
      readonly detail: string;
      /** Set when a timeout delivered a default answer instead of a member reply. */
      readonly defaultAnswer?: string;
      /** An accepted reservation whose input never arrived is cancelled, not expired. */
      readonly from?: Extract<HumanCallState, "accepted" | "pending">;
    }) => Effect.Effect<HumanCall, StoreError>;
    readonly cancelForWorkspace: (
      workspaceId: string,
      at: number,
      detail: string,
    ) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    readonly cancelForMember: (
      workspaceId: string,
      userId: string,
      at: number,
      detail: string,
    ) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    readonly cancelForRun: (
      runId: string,
      at: number,
      detail: string,
    ) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
  }
>()("t3/persistence/TeamHumanCalls/TeamHumanCallRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A state change and its audit event commit together: a crash never leaves a
  // terminal state without its event row (the house pattern, TeamMemberships.ts).
  const tx = <A>(operation: string, effect: Effect.Effect<A, StoreError>) =>
    sql.withTransaction(effect).pipe(
      Effect.catchTags({
        SqlError: (cause) => Effect.fail(toPersistenceSqlError(operation)(cause)),
      }),
    );
  const record = Effect.fn("TeamHumanCallRepository.record")(function* (
    call: { readonly id: string; readonly workspaceId: string },
    state: HumanCallState,
    at: number,
    detail: string | null,
  ) {
    yield* sql`
      INSERT INTO team_human_call_events (call_id, ordinal, state, at, detail)
      VALUES (
        ${call.id},
        (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM team_human_call_events WHERE call_id = ${call.id}),
        ${state}, ${at}, ${detail}
      )
    `.pipe(Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.record")), Effect.asVoid);
  });

  const selectOne = (workspaceId: string, id: string) =>
    sql<Record<string, unknown>>`
      SELECT ${sql.unsafe(columns)} FROM team_human_calls
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.selectOne")),
      decodeRows(decodeCalls, "TeamHumanCallRepository.selectOne"),
    );

  const transition = Effect.fn("TeamHumanCallRepository.transition")(function* (input: {
    readonly workspaceId: string;
    readonly id: string;
    readonly from: HumanCallState;
    readonly state: HumanCallState;
    readonly at: number;
    readonly detail: string;
    readonly answer?: string;
    readonly answeredBy?: string;
    readonly calleeUserId?: string;
  }) {
    return yield* tx(
      "TeamHumanCallRepository.transition",
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
        UPDATE team_human_calls
        SET state = ${input.state}, settled_at = ${input.at}, answer = ${input.answer ?? null},
            answered_by = ${input.answeredBy ?? null}, token = NULL
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.id} AND state = ${input.from}
          ${input.calleeUserId === undefined ? sql`` : sql`AND callee_user_id = ${input.calleeUserId}`}
        RETURNING ${sql.unsafe(columns)}
      `.pipe(
          Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.transition")),
          decodeRows(decodeCalls, "TeamHumanCallRepository.transition"),
        );
        const settled = rows[0];
        if (settled === undefined) return;
        yield* record(settled, input.state, input.at, input.detail);
        return settled;
      }),
    );
  });

  const cancelWhere = Effect.fn("TeamHumanCallRepository.cancelWhere")(function* (
    operation: string,
    where: Statement<unknown>,
    at: number,
    detail: string,
  ) {
    return yield* tx(
      operation,
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
        UPDATE team_human_calls SET state = 'cancelled', settled_at = ${at}, token = NULL
        WHERE state IN ('accepted', 'pending') AND ${where}
        RETURNING ${sql.unsafe(columns)}
      `.pipe(Effect.mapError(toPersistenceSqlError(operation)), decodeRows(decodeCalls, operation));
        for (const row of rows) yield* record(row, "cancelled", at, detail);
        return rows;
      }),
    );
  });

  return TeamHumanCallRepository.of({
    raise: Effect.fn("TeamHumanCallRepository.raise")(function* (input) {
      return yield* tx(
        "TeamHumanCallRepository.raise",
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
          INSERT INTO team_human_calls (
            id, workspace_id, run_id, caller_user_id, callee_user_id, question, options,
            context_link, state, token, on_timeout, default_answer, expires_at, raised_at
          ) VALUES (
            ${input.id}, ${input.workspaceId}, ${input.runId}, ${input.callerUserId},
            ${input.calleeUserId}, '', '[]', NULL, 'accepted', ${input.token},
            ${input.onTimeout}, ${input.defaultAnswer}, ${input.expiresAt}, ${input.raisedAt}
          )
          RETURNING ${sql.unsafe(columns)}
        `.pipe(
            Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.raise")),
            decodeRows(decodeCalls, "TeamHumanCallRepository.raise"),
          );
          const raised = rows[0];
          if (raised === undefined) return yield* new HumanCallRejected({ rule: "duplicate" });
          yield* record(raised, "accepted", input.raisedAt, null);
          return raised;
        }),
      );
    }),
    get: Effect.fn("TeamHumanCallRepository.get")(function* (workspaceId, id) {
      const rows = yield* selectOne(workspaceId, id);
      return rows[0];
    }),
    activate: Effect.fn("TeamHumanCallRepository.activate")(function* (input) {
      const activated = yield* tx(
        "TeamHumanCallRepository.activate",
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
          UPDATE team_human_calls
          SET state = 'pending', question = ${input.question},
              options = ${encodeOptions([...input.options])}, context_link = ${input.contextLink},
              token = NULL
          WHERE workspace_id = ${input.workspaceId} AND id = ${input.id}
            AND run_id = ${input.runId} AND state = 'accepted' AND token = ${input.token}
          RETURNING ${sql.unsafe(columns)}
        `.pipe(
            Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.activate")),
            decodeRows(decodeCalls, "TeamHumanCallRepository.activate"),
          );
          const pending = rows[0];
          if (pending !== undefined) yield* record(pending, "pending", input.at, null);
          return pending;
        }),
      );
      if (activated !== undefined) return activated;
      const existing = yield* selectOne(input.workspaceId, input.id);
      const row = existing[0];
      return yield* new HumanCallRejected({
        rule:
          row === undefined
            ? "not_found"
            : row.state !== "accepted"
              ? "token_replayed"
              : "invalid_token",
      });
    }),
    pendingForCallee: Effect.fn("TeamHumanCallRepository.pendingForCallee")(
      function* (workspaceId, calleeUserId) {
        return yield* sql<Record<string, unknown>>`
          SELECT ${sql.unsafe(fields("c."))}, u.name AS "callerName"
          FROM team_human_calls c JOIN team_users u ON u.id = c.caller_user_id
          WHERE c.workspace_id = ${workspaceId} AND c.callee_user_id = ${calleeUserId}
            AND c.state = 'pending'
          ORDER BY c.raised_at
        `.pipe(
          Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.pendingForCallee")),
          decodeRows(decodeInbox, "TeamHumanCallRepository.pendingForCallee"),
        );
      },
    ),
    pendingInWorkspace: Effect.fn("TeamHumanCallRepository.pendingInWorkspace")(
      function* (workspaceId) {
        return yield* sql<Record<string, unknown>>`
          SELECT ${sql.unsafe(columns)} FROM team_human_calls
          WHERE workspace_id = ${workspaceId} AND state = 'pending'
        `.pipe(
          Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.pendingInWorkspace")),
          decodeRows(decodeCalls, "TeamHumanCallRepository.pendingInWorkspace"),
        );
      },
    ),
    pendingByRun: Effect.fn("TeamHumanCallRepository.pendingByRun")(function* (runId) {
      return yield* sql<Record<string, unknown>>`
        SELECT ${sql.unsafe(columns)} FROM team_human_calls
        WHERE run_id = ${runId} AND state = 'pending'
      `.pipe(
        Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.pendingByRun")),
        decodeRows(decodeCalls, "TeamHumanCallRepository.pendingByRun"),
      );
    }),
    activeInWorkspace: Effect.fn("TeamHumanCallRepository.activeInWorkspace")(
      function* (workspaceId) {
        return yield* sql<Record<string, unknown>>`
          SELECT ${sql.unsafe(columns)} FROM team_human_calls
          WHERE workspace_id = ${workspaceId} AND state IN ('accepted', 'pending')
        `.pipe(
          Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.activeInWorkspace")),
          decodeRows(decodeCalls, "TeamHumanCallRepository.activeInWorkspace"),
        );
      },
    ),
    activeByRun: Effect.fn("TeamHumanCallRepository.activeByRun")(function* (runId) {
      return yield* sql<Record<string, unknown>>`
        SELECT ${sql.unsafe(columns)} FROM team_human_calls
        WHERE run_id = ${runId} AND state IN ('accepted', 'pending')
      `.pipe(
        Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.activeByRun")),
        decodeRows(decodeCalls, "TeamHumanCallRepository.activeByRun"),
      );
    }),
    recentlySettled: Effect.fn("TeamHumanCallRepository.recentlySettled")(
      function* (workspaceId, since) {
        return yield* sql<Record<string, unknown>>`
          SELECT ${sql.unsafe(columns)} FROM team_human_calls
          WHERE workspace_id = ${workspaceId} AND settled_at IS NOT NULL AND settled_at >= ${since}
          ORDER BY settled_at DESC
          LIMIT 256
        `.pipe(
          Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.recentlySettled")),
          decodeRows(decodeCalls, "TeamHumanCallRepository.recentlySettled"),
        );
      },
    ),
    latest: Effect.fn("TeamHumanCallRepository.latest")(function* (workspaceId, id) {
      const rows = yield* selectOne(workspaceId, id);
      return rows[0];
    }),
    due: Effect.fn("TeamHumanCallRepository.due")(function* (now) {
      return yield* sql<Record<string, unknown>>`
        SELECT ${sql.unsafe(columns)} FROM team_human_calls
        WHERE state IN ('accepted', 'pending') AND expires_at IS NOT NULL AND expires_at <= ${now}
        ORDER BY expires_at
      `.pipe(
        Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.due")),
        decodeRows(decodeCalls, "TeamHumanCallRepository.due"),
      );
    }),
    countActive: Effect.fn("TeamHumanCallRepository.countActive")(
      function* (workspaceId, callerUserId) {
        const rows = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM team_human_calls
          WHERE workspace_id = ${workspaceId} AND caller_user_id = ${callerUserId}
            AND state IN ('accepted', 'pending')
        `.pipe(Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.countActive")));
        return rows[0]?.count ?? 0;
      },
    ),
    countRaisedSince: Effect.fn("TeamHumanCallRepository.countRaisedSince")(
      function* (workspaceId, callerUserId, since) {
        const rows = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM team_human_calls
          WHERE workspace_id = ${workspaceId} AND caller_user_id = ${callerUserId}
            AND raised_at >= ${since}
        `.pipe(Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.countRaisedSince")));
        return rows[0]?.count ?? 0;
      },
    ),
    answer: Effect.fn("TeamHumanCallRepository.answer")(function* (input) {
      const settled = yield* transition({
        workspaceId: input.workspaceId,
        id: input.id,
        from: "pending",
        state: "answered",
        at: input.at,
        detail: input.answer,
        answer: input.answer,
        answeredBy: input.calleeUserId,
        calleeUserId: input.calleeUserId,
      });
      if (settled === undefined) {
        const existing = yield* selectOne(input.workspaceId, input.id);
        return yield* new HumanCallRejected({
          rule: existing[0] === undefined ? "not_found" : "not_pending",
        });
      }
      return settled;
    }),
    settle: Effect.fn("TeamHumanCallRepository.settle")(function* (input) {
      const settled = yield* transition({
        workspaceId: input.workspaceId,
        id: input.id,
        from: input.from ?? "pending",
        state: input.state,
        at: input.at,
        detail: input.detail,
        ...(input.defaultAnswer === undefined ? {} : { answer: input.defaultAnswer }),
      });
      if (settled === undefined) return yield* new HumanCallRejected({ rule: "not_pending" });
      return settled;
    }),
    cancelForWorkspace: Effect.fn("TeamHumanCallRepository.cancelForWorkspace")(
      function* (workspaceId, at, detail) {
        return yield* cancelWhere(
          "TeamHumanCallRepository.cancelForWorkspace",
          sql`workspace_id = ${workspaceId}`,
          at,
          detail,
        );
      },
    ),
    cancelForMember: Effect.fn("TeamHumanCallRepository.cancelForMember")(
      function* (workspaceId, userId, at, detail) {
        return yield* cancelWhere(
          "TeamHumanCallRepository.cancelForMember",
          sql`workspace_id = ${workspaceId} AND (callee_user_id = ${userId} OR caller_user_id = ${userId})`,
          at,
          detail,
        );
      },
    ),
    cancelForRun: Effect.fn("TeamHumanCallRepository.cancelForRun")(function* (runId, at, detail) {
      return yield* cancelWhere(
        "TeamHumanCallRepository.cancelForRun",
        sql`run_id = ${runId}`,
        at,
        detail,
      );
    }),
  });
});

export const layer: Layer.Layer<TeamHumanCallRepository, never, SqlClient.SqlClient> = Layer.effect(
  TeamHumanCallRepository,
  make,
);

export const isHumanCallRejected = Schema.is(HumanCallRejected);
