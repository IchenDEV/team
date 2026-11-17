import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceDecodeError, PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

export const HumanCallState = Schema.Literals(["pending", "answered", "expired", "cancelled"]);
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
    rule: Schema.Literals(["not_found", "not_pending", "duplicate"]),
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
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly contextLink: string | null;
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
  ${prefix}on_timeout AS "onTimeout", ${prefix}default_answer AS "defaultAnswer",
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
    readonly raise: (input: RaiseHumanCallInput) => Effect.Effect<void, StoreError>;
    readonly pendingForCallee: (
      workspaceId: string,
      calleeUserId: string,
    ) => Effect.Effect<ReadonlyArray<HumanCallInInbox>, StoreError>;
    readonly pendingInWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    readonly pendingByRun: (runId: string) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    readonly due: (now: number) => Effect.Effect<ReadonlyArray<HumanCall>, StoreError>;
    readonly countPending: (
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
  }
>()("t3/persistence/TeamHumanCalls/TeamHumanCallRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

  const insert = Effect.fn("TeamHumanCallRepository.insert")(function* (
    input: RaiseHumanCallInput,
  ) {
    return yield* sql`
      INSERT INTO team_human_calls (
        id, workspace_id, run_id, caller_user_id, callee_user_id, question, options, context_link,
        state, on_timeout, default_answer, expires_at, raised_at
      ) VALUES (
        ${input.id}, ${input.workspaceId}, ${input.runId}, ${input.callerUserId},
        ${input.calleeUserId}, ${input.question}, ${encodeOptions([...input.options])},
        ${input.contextLink}, 'pending', ${input.onTimeout}, ${input.defaultAnswer},
        ${input.expiresAt}, ${input.raisedAt}
      )
    `.pipe(Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.insert")), Effect.asVoid);
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
    const rows = yield* sql<Record<string, unknown>>`
        UPDATE team_human_calls
        SET state = ${input.state}, settled_at = ${input.at}, answer = ${input.answer ?? null},
            answered_by = ${input.answeredBy ?? null}
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
  });

  const finishCancel = Effect.fn("TeamHumanCallRepository.finishCancel")(function* (
    rows: ReadonlyArray<HumanCall>,
    at: number,
    detail: string,
  ) {
    for (const row of rows) yield* record(row, "cancelled", at, detail);
    return rows;
  });

  return TeamHumanCallRepository.of({
    raise: Effect.fn("TeamHumanCallRepository.raise")(function* (input) {
      const existing = yield* selectOne(input.workspaceId, input.id);
      if (existing.length > 0) return yield* new HumanCallRejected({ rule: "duplicate" });
      yield* insert(input);
      yield* record(
        { id: input.id, workspaceId: input.workspaceId },
        "pending",
        input.raisedAt,
        null,
      );
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
    due: Effect.fn("TeamHumanCallRepository.due")(function* (now) {
      return yield* sql<Record<string, unknown>>`
        SELECT ${sql.unsafe(columns)} FROM team_human_calls
        WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ${now}
        ORDER BY expires_at
      `.pipe(
        Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.due")),
        decodeRows(decodeCalls, "TeamHumanCallRepository.due"),
      );
    }),
    countPending: Effect.fn("TeamHumanCallRepository.countPending")(
      function* (workspaceId, callerUserId) {
        const rows = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM team_human_calls
          WHERE workspace_id = ${workspaceId} AND caller_user_id = ${callerUserId}
            AND state = 'pending'
        `.pipe(Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.countPending")));
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
        from: "pending",
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
        const rows = yield* sql<Record<string, unknown>>`
          UPDATE team_human_calls SET state = 'cancelled', settled_at = ${at}
          WHERE state = 'pending' AND workspace_id = ${workspaceId}
          RETURNING ${sql.unsafe(columns)}
        `.pipe(
          Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.cancelForWorkspace")),
          decodeRows(decodeCalls, "TeamHumanCallRepository.cancelForWorkspace"),
        );
        return yield* finishCancel(rows, at, detail);
      },
    ),
    cancelForMember: Effect.fn("TeamHumanCallRepository.cancelForMember")(
      function* (workspaceId, userId, at, detail) {
        const rows = yield* sql<Record<string, unknown>>`
          UPDATE team_human_calls SET state = 'cancelled', settled_at = ${at}
          WHERE state = 'pending' AND workspace_id = ${workspaceId}
            AND (callee_user_id = ${userId} OR caller_user_id = ${userId})
          RETURNING ${sql.unsafe(columns)}
        `.pipe(
          Effect.mapError(toPersistenceSqlError("TeamHumanCallRepository.cancelForMember")),
          decodeRows(decodeCalls, "TeamHumanCallRepository.cancelForMember"),
        );
        return yield* finishCancel(rows, at, detail);
      },
    ),
  });
});

export const layer: Layer.Layer<TeamHumanCallRepository, never, SqlClient.SqlClient> = Layer.effect(
  TeamHumanCallRepository,
  make,
);

export const isHumanCallRejected = Schema.is(HumanCallRejected);
