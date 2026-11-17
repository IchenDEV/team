import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  TeamHumanCallRepository,
  type HumanCall,
  type HumanCallRateLimits,
  type HumanCallTimeout,
} from "../persistence/TeamHumanCalls.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import { TeamExecutionBoundary } from "./TeamExecutionBoundary.ts";

/**
 * Calls travel through the run's own workspace directory: a sandboxed run has no
 * network and no credential, so its mounted root is the only channel it shares
 * with the gateway. The run writes one request file, then waits for one state
 * file; the relay turns those files into durable rows and back.
 */
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60;
const MAX_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;
const MAX_QUESTION = 2_000;
const MAX_OPTIONS = 5;
const MAX_ANSWER = 4_000;

export const callsDir = (root: string) => `${root}/calls`;
export const requestPath = (root: string, callId: string) => `${callsDir(root)}/${callId}.json`;
export const statePath = (root: string, callId: string) => `${callsDir(root)}/${callId}.state.json`;

export const HumanCallRequest = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  to: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  question: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_QUESTION)),
  options: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(
      Schema.isMaxLength(MAX_OPTIONS),
    ),
  ),
  contextLink: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  timeoutSeconds: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS),
    ),
  ),
  onTimeout: Schema.optional(Schema.Literals(["expire", "default_answer", "keep_waiting"])),
  defaultAnswer: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ANSWER)),
  ),
});
export type HumanCallRequest = typeof HumanCallRequest.Type;

/** What the waiting run reads: `state` decides whether it keeps waiting. */
export const HumanCallStateFile = Schema.Struct({
  callId: Schema.String,
  state: Schema.Literals(["pending", "answered", "expired", "cancelled", "rejected"]),
  question: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
  answer: Schema.optional(Schema.String),
  answeredBy: Schema.optional(Schema.String),
  /** True when the answer is the timeout default, not a member's reply. */
  defaulted: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
});
export type HumanCallStateFile = typeof HumanCallStateFile.Type;

export class HumanCallRelay extends Context.Service<
  HumanCallRelay,
  {
    /** Accepts new request files, expires overdue calls, and settles their files. */
    readonly tick: () => Effect.Effect<void>;
    readonly deliver: (call: HumanCall) => Effect.Effect<void>;
    readonly cancelWorkspace: (workspaceId: string, detail: string) => Effect.Effect<void>;
    readonly cancelMember: (workspaceId: string, userId: string) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void>;
  }
>()("t3/team/TeamHumanCalls/HumanCallRelay") {}

export interface HumanCallRelayOptions {
  readonly root: (workspaceId: string) => string;
  readonly workspaceIds: ReadonlyArray<string>;
  readonly rateLimits?: HumanCallRateLimits;
  readonly clock?: () => number;
}

const DEFAULT_RATE_LIMITS: HumanCallRateLimits = { pending: 3, perHour: 20 };

const decodeRequest = Schema.decodeUnknownEffect(HumanCallRequest);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeStateFile = Schema.encodeSync(Schema.fromJsonString(HumanCallStateFile));
const MEMBERSHIP_SUBJECT = (userId: string) => TeamMemberships.userSubject(userId);

export const layer = (options: HumanCallRelayOptions) =>
  Layer.effect(
    HumanCallRelay,
    Effect.gen(function* () {
      const calls = yield* TeamHumanCallRepository;
      const members = yield* TeamMemberships.TeamMembershipRepository;
      const boundary = yield* TeamExecutionBoundary;
      const fs = yield* FileSystem.FileSystem;
      const limits = options.rateLimits ?? DEFAULT_RATE_LIMITS;
      const now = options.clock ?? Date.now;

      const writeStateFile = Effect.fn("HumanCallRelay.writeState")(function* (
        workspaceId: string,
        state: HumanCallStateFile,
      ) {
        const target = statePath(options.root(workspaceId), state.callId);
        const temp = `${target}.tmp`;
        // Write then rename, so a waiting run never reads half a file.
        yield* fs.writeFileString(temp, `${encodeStateFile(state)}\n`);
        yield* fs.rename(temp, target);
      });
      // A state file the run cannot read is a written-off call, so a failure is loud but never fatal.
      const writeState = (workspaceId: string, state: HumanCallStateFile) =>
        writeStateFile(workspaceId, state).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("human_call state file write failed", {
              callId: state.callId,
              workspaceId,
              cause,
            }),
          ),
        );

      const stateOf = (call: HumanCall): HumanCallStateFile => {
        const base = {
          callId: call.id,
          question: call.question,
          ...(call.expiresAt === null ? {} : { expiresAt: call.expiresAt }),
        };
        switch (call.state) {
          case "pending":
            return { ...base, state: "pending" };
          case "answered":
            return {
              ...base,
              state: "answered",
              ...(call.answer === null ? {} : { answer: call.answer }),
              ...(call.answeredBy === null ? {} : { answeredBy: call.answeredBy }),
            };
          case "expired":
            return {
              ...base,
              state: "expired",
              ...(call.answer === null
                ? { defaulted: false }
                : { answer: call.answer, defaulted: true }),
            };
          case "cancelled":
            return { ...base, state: "cancelled" };
        }
      };

      const isMember = (workspaceId: string, userId: string) =>
        members.resolve(MEMBERSHIP_SUBJECT(userId), workspaceId).pipe(
          Effect.as(true),
          Effect.catchIf(TeamMemberships.isMembershipError, () => Effect.succeed(false)),
        );

      // A request is accepted once. The request file is renamed by its outcome so a
      // later tick never reads it again, while the run keeps polling its state file.
      const settleFile = (workspaceId: string, callId: string, outcome: "accepted" | "rejected") =>
        fs
          .rename(
            requestPath(options.root(workspaceId), callId),
            `${requestPath(options.root(workspaceId), callId)}.${outcome}`,
          )
          .pipe(Effect.ignore);

      const reject = (workspaceId: string, callId: string, reason: string) =>
        writeState(workspaceId, { callId, state: "rejected", reason }).pipe(
          Effect.andThen(settleFile(workspaceId, callId, "rejected")),
        );

      const accept = Effect.fn("HumanCallRelay.accept")(function* (
        workspaceId: string,
        callId: string,
        request: HumanCallRequest,
      ) {
        const callerUserId = request.runId.split(".")[2] ?? "";
        if (callerUserId === "") return yield* reject(workspaceId, callId, "caller_run_missing");
        if (!(yield* isMember(workspaceId, callerUserId)))
          return yield* reject(workspaceId, callId, "caller_not_member");
        if (callerUserId === request.to)
          return yield* reject(workspaceId, callId, "callee_is_caller");
        if (!(yield* isMember(workspaceId, request.to)))
          return yield* reject(workspaceId, callId, "callee_not_member");
        const run = yield* boundary
          .read({ id: workspaceId, credentials: {}, networkMode: "none" }, request.runId)
          .pipe(Effect.option, Effect.map(Option.getOrUndefined));
        if (run === undefined || run.status !== "running")
          return yield* reject(workspaceId, callId, "caller_run_not_running");
        const [pending, raised] = yield* Effect.all([
          calls.countPending(workspaceId, callerUserId),
          calls.countRaisedSince(workspaceId, callerUserId, now() - 60 * 60 * 1000),
        ]);
        if (pending >= limits.pending)
          return yield* reject(workspaceId, callId, "rate_limited_pending");
        if (raised >= limits.perHour)
          return yield* reject(workspaceId, callId, "rate_limited_hourly");
        const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
        const onTimeout: HumanCallTimeout = request.onTimeout ?? "expire";
        const expiresAt =
          onTimeout === "keep_waiting" || timeoutSeconds === 0
            ? null
            : now() + timeoutSeconds * 1_000;
        yield* calls.raise({
          id: callId,
          workspaceId,
          runId: request.runId,
          callerUserId,
          calleeUserId: request.to,
          question: request.question,
          options: request.options ?? [],
          contextLink: request.contextLink ?? null,
          onTimeout,
          defaultAnswer: request.defaultAnswer ?? null,
          expiresAt,
          raisedAt: now(),
        });
        yield* writeState(workspaceId, {
          callId,
          state: "pending",
          question: request.question,
          expiresAt,
        });
        yield* settleFile(workspaceId, callId, "accepted");
      });

      const scanWorkspace = Effect.fn("HumanCallRelay.scanWorkspace")(function* (
        workspaceId: string,
      ) {
        const dir = callsDir(options.root(workspaceId));
        const entries = yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const entry of entries) {
          if (!entry.endsWith(".json") || entry.endsWith(".state.json")) continue;
          const callId = entry.slice(0, -".json".length);
          if (!CALL_ID_PATTERN.test(callId)) continue;
          const path = `${dir}/${entry}`;
          // A run owns this directory: it can leave a FIFO or a directory named like a
          // request. Only a regular file is read, and one read never stalls the tick.
          const info = yield* fs.stat(path).pipe(Effect.option);
          if (info._tag === "None" || info.value.type !== "File") {
            yield* reject(workspaceId, callId, "not_a_regular_file").pipe(Effect.ignore);
            continue;
          }
          // One file can never stop the scan: its own failure settles that file only,
          // so the next tick does not read it again and expiry keeps running.
          yield* handleRequest(workspaceId, callId, path).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.catchCause((cause) =>
              Effect.logWarning("human_call request failed", { workspaceId, callId, cause }).pipe(
                Effect.andThen(settleFile(workspaceId, callId, "rejected")),
              ),
            ),
            Effect.ignore,
          );
        }
      });

      const handleRequest = Effect.fn("HumanCallRelay.handleRequest")(function* (
        workspaceId: string,
        callId: string,
        path: string,
      ) {
        const raw = yield* fs.readFileString(path);
        if (raw.length === 0) return yield* reject(workspaceId, callId, "empty_request");
        const parsed = yield* decodeUnknownJson(raw).pipe(Effect.option);
        if (parsed._tag === "None") return yield* reject(workspaceId, callId, "invalid_json");
        const request = yield* decodeRequest(parsed.value).pipe(Effect.option);
        if (request._tag === "None") return yield* reject(workspaceId, callId, "invalid_request");
        yield* accept(workspaceId, callId, request.value);
      });

      const expireDue = Effect.gen(function* () {
        const due = yield* calls.due(now()).pipe(Effect.orElseSucceed(() => []));
        for (const call of due) {
          const settled = yield* calls
            .settle({
              workspaceId: call.workspaceId,
              id: call.id,
              state: "expired",
              at: now(),
              detail:
                call.onTimeout === "default_answer"
                  ? "timeout delivered the default answer"
                  : "timeout reached with no answer",
              ...(call.onTimeout === "default_answer" && call.defaultAnswer !== null
                ? { defaultAnswer: call.defaultAnswer }
                : {}),
            })
            .pipe(Effect.option);
          if (Option.isSome(settled)) yield* writeState(call.workspaceId, stateOf(settled.value));
        }
      });

      const tick = Effect.gen(function* () {
        yield* Effect.forEach(
          options.workspaceIds,
          (workspaceId) =>
            scanWorkspace(workspaceId).pipe(
              // A defect (not a typed failure) must not skip the others or the deadline pass.
              Effect.catchCause((cause) =>
                Effect.logError("human_call workspace scan failed", { workspaceId, cause }),
              ),
            ),
          { discard: true },
        );
        // Expiry runs even when a scan failed: a pending call always reaches a deadline.
        yield* expireDue;
      });

      const cancelAndDeliver = (cancelled: ReadonlyArray<HumanCall>) =>
        Effect.forEach(cancelled, (call) => writeState(call.workspaceId, stateOf(call)), {
          discard: true,
        });

      return HumanCallRelay.of({
        tick: Effect.fn("HumanCallRelay.tick")(() => tick),
        deliver: Effect.fn("HumanCallRelay.deliver")((call) =>
          writeState(call.workspaceId, stateOf(call)),
        ),
        cancelWorkspace: Effect.fn("HumanCallRelay.cancelWorkspace")(
          function* (workspaceId, detail) {
            const cancelled = yield* calls
              .cancelForWorkspace(workspaceId, now(), detail)
              .pipe(
                Effect.catch((cause) =>
                  Effect.logError("human_call cancellation failed", { workspaceId, cause }).pipe(
                    Effect.as([] as ReadonlyArray<HumanCall>),
                  ),
                ),
              );
            yield* cancelAndDeliver(cancelled);
          },
        ),
        cancelMember: Effect.fn("HumanCallRelay.cancelMember")(function* (workspaceId, userId) {
          const cancelled = yield* calls
            .cancelForMember(workspaceId, userId, now(), "membership removed")
            .pipe(
              Effect.catch((cause) =>
                Effect.logError("human_call cancellation failed", {
                  workspaceId,
                  userId,
                  cause,
                }).pipe(Effect.as([] as ReadonlyArray<HumanCall>)),
              ),
            );
          yield* cancelAndDeliver(cancelled);
        }),
        start: Effect.fn("HumanCallRelay.start")(() =>
          tick.pipe(
            Effect.andThen(Effect.sleep("1 second")),
            Effect.forever,
            Effect.catchCause(Effect.logError),
          ),
        ),
      });
    }),
  );

/** Runs the relay for the lifetime of the layer's scope. */
export const tickLoop = Layer.effectDiscard(
  Effect.gen(function* () {
    const relay = yield* HumanCallRelay;
    yield* Effect.forkScoped(relay.start());
  }),
);
