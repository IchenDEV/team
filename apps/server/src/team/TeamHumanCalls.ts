// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import {
  TeamHumanCallRepository,
  type HumanCall,
  type HumanCallRateLimits,
  type HumanCallTimeout,
} from "../persistence/TeamHumanCalls.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import { TeamExecutionBoundary, channelDir, scopedRunId } from "./TeamExecutionBoundary.ts";

/**
 * Protocol v2: the gateway owns each run's private channel (outbox rw, inbox ro;
 * no peer run mounts it). The run writes a fixed-name intent; the gateway derives
 * the caller, reserves the id and issues a one-time (run, call) token that names
 * the input file. See HUMAN_CALL_CHANNEL.md for the protocol and switchover order.
 */
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60;
const MAX_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;
const MAX_QUESTION = 2_000;
const MAX_OPTIONS = 5;
const MAX_ANSWER = 4_000;
/** An intent or input is a few hundred bytes; a larger file is refused before it is read into memory. */
const MAX_REQUEST_BYTES = 16 * 1_024;
/** One tick handles a bounded number of input files per run. */
const MAX_ENTRIES_PER_TICK = 64;
/** Queue capacity: an outbox holding more entries than this is trimmed, garbage first. */
const MAX_OUTBOX_ENTRIES = 256;
const MAX_GARBAGE_PER_TICK = 256;
/** A file younger than this may be mid-write; an unparseable one is retried, not rejected. */
const WRITE_GRACE_MS = 2_000;
/** Terminal state files missed by a crash are re-delivered within this window. */
const REDELIVERY_WINDOW_MS = 60 * 60 * 1_000;

export const outboxDir = (channel: string) => `${channel}/outbox`;
export const inboxDir = (channel: string) => `${channel}/inbox`;
export const intentPath = (channel: string) => `${outboxDir(channel)}/request.json`;
export const inputPath = (channel: string, callId: string) =>
  `${outboxDir(channel)}/${callId}.input.json`;
export const statePath = (channel: string, callId: string) =>
  `${inboxDir(channel)}/${callId}.state.json`;
export const errorPath = (channel: string, callId: string) =>
  `${inboxDir(channel)}/${callId}.error.json`;
/** Intent rejections have no call id yet; one fixed file carries the latest reason. */
export const rejectedIntentPath = (channel: string) => `${inboxDir(channel)}/rejected.json`;

/** What the run writes to request.json: the reservation, never its own identity. */
export const HumanCallIntent = Schema.Struct({
  to: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
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
export type HumanCallIntent = typeof HumanCallIntent.Type;

/** What the run writes to the gateway-designated input file, under the one-time token. */
export const HumanCallInput = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  question: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_QUESTION)),
  options: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(
      Schema.isMaxLength(MAX_OPTIONS),
    ),
  ),
  contextLink: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type HumanCallInput = typeof HumanCallInput.Type;

/** What the waiting run reads: `state` decides whether it keeps waiting. */
export const HumanCallStateFile = Schema.Struct({
  callId: Schema.String,
  state: Schema.Literals(["accepted", "pending", "answered", "expired", "cancelled"]),
  /** Accepted only: the one-time token and the input file the gateway designated. */
  token: Schema.optional(Schema.String),
  inputFile: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
  answer: Schema.optional(Schema.String),
  answeredBy: Schema.optional(Schema.String),
  /** True when the answer is the timeout default, not a member's reply. */
  defaulted: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
});
export type HumanCallStateFile = typeof HumanCallStateFile.Type;

/** Input rejections ride beside the state file, never over it: the live state stays intact. */
export const HumanCallErrorFile = Schema.Struct({
  callId: Schema.String,
  reason: Schema.String,
  at: Schema.Number,
});
export type HumanCallErrorFile = typeof HumanCallErrorFile.Type;

/** An intent rejected before reservation has no call id; one fixed file carries the latest reason. */
export const RejectedIntentFile = Schema.Struct({
  state: Schema.Literal("rejected"),
  reason: Schema.String,
  at: Schema.Number,
});
export type RejectedIntentFile = typeof RejectedIntentFile.Type;

export class HumanCallRelay extends Context.Service<
  HumanCallRelay,
  {
    /** Scans run outboxes, reconciles state files, and expires overdue calls. */
    readonly tick: () => Effect.Effect<void>;
    readonly deliver: (call: HumanCall) => Effect.Effect<void>;
    readonly cancelWorkspace: (workspaceId: string, detail: string) => Effect.Effect<void>;
    readonly cancelMember: (workspaceId: string, userId: string) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void>;
  }
>()("t3/team/TeamHumanCalls/HumanCallRelay") {}

export interface HumanCallRelayOptions {
  readonly stateDir: string;
  readonly workspaceIds: ReadonlyArray<string>;
  readonly rateLimits?: HumanCallRateLimits;
  readonly clock?: () => number;
}

const DEFAULT_RATE_LIMITS: HumanCallRateLimits = { pending: 3, perHour: 20 };

const decodeIntent = Schema.decodeUnknownEffect(HumanCallIntent);
const decodeInput = Schema.decodeUnknownEffect(HumanCallInput);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeStateFile = Schema.encodeSync(Schema.fromJsonString(HumanCallStateFile));
const encodeErrorFile = Schema.encodeSync(Schema.fromJsonString(HumanCallErrorFile));
const encodeRejectedIntent = Schema.encodeSync(Schema.fromJsonString(RejectedIntentFile));
const MEMBERSHIP_SUBJECT = (userId: string) => TeamMemberships.userSubject(userId);

const newCallId = () => `hc-${NodeCrypto.randomBytes(8).toString("hex")}`;
const newToken = () => NodeCrypto.randomBytes(24).toString("base64url");

/** A read refusal carries the rejection reason; the file is always settled by the caller. */
interface ReadRefusal {
  readonly reason: string;
}

const openFlags =
  NodeFSP.constants.O_RDONLY | NodeFSP.constants.O_NOFOLLOW | NodeFSP.constants.O_NONBLOCK;

/**
 * One handle from open to read: O_NOFOLLOW refuses a symlink, O_NONBLOCK refuses
 * to hang on a FIFO, fstat on the handle refuses anything but a regular file,
 * and the read itself is bounded, so a swap or a sparse giant between stat and
 * read can neither stall the tick nor allocate without limit.
 */
const readBounded = (path: string): Effect.Effect<{ text: string; mtimeMs: number }, ReadRefusal> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await NodeFSP.open(path, openFlags);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("not_a_regular_file");
        if (info.size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
        const buffer = Buffer.allocUnsafe(MAX_REQUEST_BYTES + 1);
        let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
        if (total > MAX_REQUEST_BYTES) throw new Error("request_too_large");
        return { text: buffer.toString("utf8", 0, total), mtimeMs: info.mtimeMs };
      } finally {
        await handle.close();
      }
    },
    catch: (cause): ReadRefusal => {
      if (cause instanceof Error) {
        if (cause.message === "not_a_regular_file" || cause.message === "request_too_large")
          return { reason: cause.message };
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { reason: "missing" };
        if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR")
          return { reason: "not_a_regular_file" };
      }
      return { reason: "unreadable_request" };
    },
  });

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

      const channelOf = (workspaceId: string, runId: string) =>
        channelDir(options.stateDir, workspaceId, runId);

      // Write then rename inside the gateway-owned inbox, so a waiting run never
      // reads half a file and no run can plant a temp-path symlink.
      const writeJson = Effect.fn("HumanCallRelay.writeJson")(function* (
        target: string,
        text: string,
      ) {
        yield* fs.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true });
        const temp = `${target}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
        yield* fs.writeFileString(temp, `${text}\n`);
        yield* fs.rename(temp, target);
      });
      // A state file the run cannot read is a written-off call, so a failure is loud but never fatal.
      const writeState = (workspaceId: string, runId: string, state: HumanCallStateFile) =>
        writeJson(
          statePath(channelOf(workspaceId, runId), state.callId),
          encodeStateFile(state),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("human_call state file write failed", {
              callId: state.callId,
              workspaceId,
              cause,
            }),
          ),
        );
      const writeError = (workspaceId: string, runId: string, callId: string, reason: string) =>
        writeJson(
          errorPath(channelOf(workspaceId, runId), callId),
          encodeErrorFile({ callId, reason, at: now() }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("human_call error file write failed", { callId, cause }),
          ),
        );

      const stateOf = (call: HumanCall): HumanCallStateFile => {
        const base = {
          callId: call.id,
          ...(call.question === "" ? {} : { question: call.question }),
          ...(call.expiresAt === null ? {} : { expiresAt: call.expiresAt }),
        };
        switch (call.state) {
          case "accepted":
            return {
              ...base,
              state: "accepted",
              ...(call.token === null ? {} : { token: call.token }),
              inputFile: `${call.id}.input.json`,
            };
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

      const settleIntent = (workspaceId: string, runId: string) =>
        fs
          .remove(intentPath(channelOf(workspaceId, runId)), { recursive: true, force: true })
          .pipe(Effect.ignore);

      const rejectIntent = (workspaceId: string, runId: string, reason: string) =>
        writeJson(
          rejectedIntentPath(channelOf(workspaceId, runId)),
          encodeRejectedIntent({ state: "rejected", reason, at: now() }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("human_call rejection file write failed", { runId, cause }),
          ),
          Effect.andThen(settleIntent(workspaceId, runId)),
        );

      const acceptIntent = Effect.fn("HumanCallRelay.acceptIntent")(function* (
        workspaceId: string,
        runId: string,
        intent: HumanCallIntent,
      ) {
        // Identity comes from the channel the gateway mounted for this run, never
        // from the file: the run id's member segment is the caller.
        const callerUserId = runId.split(".")[2] ?? "";
        if (!(yield* isMember(workspaceId, callerUserId)))
          return yield* rejectIntent(workspaceId, runId, "caller_not_member");
        if (callerUserId === intent.to)
          return yield* rejectIntent(workspaceId, runId, "callee_is_caller");
        if (!(yield* isMember(workspaceId, intent.to)))
          return yield* rejectIntent(workspaceId, runId, "callee_not_member");
        const run = yield* boundary
          .read({ id: workspaceId, credentials: {}, networkMode: "none" }, runId)
          .pipe(Effect.option, Effect.map(Option.getOrUndefined));
        if (run === undefined || run.status !== "running")
          return yield* rejectIntent(workspaceId, runId, "caller_run_not_running");
        // One reservation at a time per run: the input must arrive before the next intent.
        const quotas = yield* Effect.all([
          calls.activeByRun(runId),
          calls.countActive(workspaceId, callerUserId),
          calls.countRaisedSince(workspaceId, callerUserId, now() - 60 * 60 * 1000),
        ]).pipe(Effect.option);
        if (Option.isNone(quotas))
          return yield* rejectIntent(workspaceId, runId, "storage_failure");
        const [active, pending, raised] = quotas.value;
        if (active.some((call) => call.state === "accepted"))
          return yield* rejectIntent(workspaceId, runId, "input_pending");
        if (pending >= limits.pending)
          return yield* rejectIntent(workspaceId, runId, "rate_limited_pending");
        if (raised >= limits.perHour)
          return yield* rejectIntent(workspaceId, runId, "rate_limited_hourly");
        const timeoutSeconds = intent.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
        const onTimeout: HumanCallTimeout = intent.onTimeout ?? "expire";
        const expiresAt =
          onTimeout === "keep_waiting" || timeoutSeconds === 0
            ? null
            : now() + timeoutSeconds * 1_000;
        const raisedCall = yield* calls
          .raise({
            id: newCallId(),
            workspaceId,
            runId,
            callerUserId,
            calleeUserId: intent.to,
            token: newToken(),
            onTimeout,
            defaultAnswer: intent.defaultAnswer ?? null,
            expiresAt,
            raisedAt: now(),
          })
          .pipe(Effect.option);
        if (Option.isNone(raisedCall))
          return yield* rejectIntent(workspaceId, runId, "storage_failure");
        yield* writeState(workspaceId, runId, stateOf(raisedCall.value));
        yield* settleIntent(workspaceId, runId);
      });

      const handleIntent = Effect.fn("HumanCallRelay.handleIntent")(function* (
        workspaceId: string,
        runId: string,
      ) {
        const path = intentPath(channelOf(workspaceId, runId));
        const read = yield* readBounded(path).pipe(
          Effect.asSome,
          Effect.catch((refusal: ReadRefusal) =>
            refusal.reason === "missing"
              ? Effect.succeedNone
              : rejectIntent(workspaceId, runId, refusal.reason).pipe(Effect.as(Option.none())),
          ),
        );
        if (Option.isNone(read)) return;
        const { text, mtimeMs } = read.value;
        const parsed = yield* decodeUnknownJson(text).pipe(Effect.option);
        if (parsed._tag === "None") {
          // A file still being written is retried next tick, not lost. The grace
          // compares wall-clock now against the file's wall-clock mtime, so it
          // must not use the logical (possibly test) clock.
          // @effect-diagnostics-next-line globalDateInEffect:off -- wall-clock write grace vs file mtime
          if (Date.now() - mtimeMs < WRITE_GRACE_MS) return;
          return yield* rejectIntent(
            workspaceId,
            runId,
            text.length === 0 ? "empty_request" : "invalid_json",
          );
        }
        const intent = yield* decodeIntent(parsed.value).pipe(Effect.option);
        if (intent._tag === "None")
          return yield* rejectIntent(workspaceId, runId, "invalid_request");
        yield* acceptIntent(workspaceId, runId, intent.value);
      });

      const handleInput = Effect.fn("HumanCallRelay.handleInput")(function* (
        workspaceId: string,
        runId: string,
        callId: string,
      ) {
        const channel = channelOf(workspaceId, runId);
        const settle = fs
          .remove(inputPath(channel, callId), { recursive: true, force: true })
          .pipe(Effect.ignore);
        const read = yield* readBounded(inputPath(channel, callId)).pipe(
          Effect.asSome,
          Effect.catch((refusal: ReadRefusal) =>
            refusal.reason === "missing"
              ? Effect.succeedNone
              : writeError(workspaceId, runId, callId, refusal.reason).pipe(
                  Effect.andThen(settle),
                  Effect.as(Option.none()),
                ),
          ),
        );
        if (Option.isNone(read)) return;
        const { text, mtimeMs } = read.value;
        const parsed = yield* decodeUnknownJson(text).pipe(Effect.option);
        if (parsed._tag === "None") {
          // @effect-diagnostics-next-line globalDateInEffect:off -- wall-clock write grace vs file mtime
          if (Date.now() - mtimeMs < WRITE_GRACE_MS) return;
          yield* writeError(workspaceId, runId, callId, "invalid_json");
          return yield* settle;
        }
        const input = yield* decodeInput(parsed.value).pipe(Effect.option);
        if (input._tag === "None") {
          yield* writeError(workspaceId, runId, callId, "invalid_request");
          return yield* settle;
        }
        // The token is bound to this run and this call: another run's outbox can
        // never activate it, and a consumed token is a replay.
        const activated = yield* calls
          .activate({
            workspaceId,
            id: callId,
            runId,
            token: input.value.token,
            question: input.value.question,
            options: input.value.options ?? [],
            contextLink: input.value.contextLink ?? null,
            at: now(),
          })
          .pipe(Effect.option);
        if (Option.isSome(activated)) {
          yield* writeState(workspaceId, runId, stateOf(activated.value));
          return yield* settle;
        }
        const failure = yield* calls.get(workspaceId, callId).pipe(Effect.option);
        const reason =
          Option.isNone(failure) || failure.value === undefined
            ? "unknown_call"
            : failure.value.state !== "accepted"
              ? "token_replayed"
              : "invalid_token";
        yield* writeError(workspaceId, runId, callId, reason);
        yield* settle;
      });

      // One entry can never stop the scan: its own failure settles that file only.
      const contained = <E>(
        workspaceId: string,
        runId: string,
        path: string,
        effect: Effect.Effect<void, E>,
      ) =>
        effect.pipe(
          Effect.timeoutOption("5 seconds"),
          Effect.flatMap((outcome) =>
            outcome._tag === "Some"
              ? Effect.void
              : Effect.logWarning("human_call entry timed out", { workspaceId, runId, path }).pipe(
                  Effect.andThen(
                    fs.remove(path, { recursive: true, force: true }).pipe(Effect.ignore),
                  ),
                ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("human_call entry failed", { workspaceId, runId, path, cause }).pipe(
              Effect.andThen(fs.remove(path, { recursive: true, force: true }).pipe(Effect.ignore)),
            ),
          ),
          Effect.ignore,
        );

      const scanOutbox = Effect.fn("HumanCallRelay.scanOutbox")(function* (
        workspaceId: string,
        runId: string,
      ) {
        const dir = outboxDir(channelOf(workspaceId, runId));
        const listed = (yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)))
          .slice()
          .sort();
        const isInput = (entry: string) =>
          entry.endsWith(".input.json") &&
          CALL_ID_PATTERN.test(entry.slice(0, -".input.json".length));
        // Garbage outside the protocol is deleted, so it can never occupy the scan
        // window or starve a real request out of every tick.
        const garbage = listed.filter((entry) => entry !== "request.json" && !isInput(entry));
        for (const entry of garbage.slice(0, MAX_GARBAGE_PER_TICK))
          yield* fs.remove(`${dir}/${entry}`, { recursive: true, force: true }).pipe(Effect.ignore);
        let protocol = listed.filter((entry) => entry === "request.json" || isInput(entry));
        // Queue capacity: a flooded outbox is trimmed to the bound, oldest names first.
        if (protocol.length > MAX_OUTBOX_ENTRIES) {
          for (const entry of protocol.slice(MAX_OUTBOX_ENTRIES))
            yield* fs
              .remove(`${dir}/${entry}`, { recursive: true, force: true })
              .pipe(Effect.ignore);
          protocol = protocol.slice(0, MAX_OUTBOX_ENTRIES);
        }
        if (protocol.includes("request.json"))
          yield* contained(
            workspaceId,
            runId,
            intentPath(channelOf(workspaceId, runId)),
            handleIntent(workspaceId, runId),
          );
        let handled = 0;
        for (const entry of protocol) {
          if (entry === "request.json" || handled >= MAX_ENTRIES_PER_TICK) continue;
          handled += 1;
          const callId = entry.slice(0, -".input.json".length);
          yield* contained(
            workspaceId,
            runId,
            inputPath(channelOf(workspaceId, runId), callId),
            handleInput(workspaceId, runId, callId),
          );
        }
      });

      const scanWorkspace = Effect.fn("HumanCallRelay.scanWorkspace")(function* (
        workspaceId: string,
      ) {
        const channelsRoot = `${options.stateDir}/workspaces/${workspaceId}/channels`;
        const runIds = yield* fs
          .readDirectory(channelsRoot)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const runId of runIds) {
          // Only gateway-created channel directories are scanned; the run id must
          // belong to this workspace, so a stray name never becomes an identity.
          if (!scopedRunId(workspaceId, runId)) continue;
          yield* scanOutbox(workspaceId, runId).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("human_call outbox scan failed", { workspaceId, runId, cause }),
            ),
          );
        }
      });

      const cancelAndDeliver = (cancelled: ReadonlyArray<HumanCall>) =>
        Effect.forEach(
          cancelled,
          (call) => writeState(call.workspaceId, call.runId, stateOf(call)),
          { discard: true },
        );

      // A crash between a DB transition and its state file must never strand a run:
      // active calls are re-delivered every tick, recent terminal ones when missing.
      const reconcileWorkspace = Effect.fn("HumanCallRelay.reconcileWorkspace")(function* (
        workspaceId: string,
      ) {
        const active = yield* calls
          .activeInWorkspace(workspaceId)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<HumanCall>));
        for (const call of active) {
          const status = yield* boundary
            .read({ id: workspaceId, credentials: {}, networkMode: "none" }, call.runId)
            .pipe(
              Effect.map((run) => run.status),
              Effect.catchTags({
                SandboxRunNotFound: () => Effect.succeed("ended" as const),
                SandboxRevoked: () => Effect.succeed("ended" as const),
              }),
              Effect.orElseSucceed(() => "unknown" as const),
            );
          if (status === "unknown") continue;
          if (status !== "running" && status !== "waiting") {
            // A dead caller's calls never hold its quota or wait for a reply.
            const cancelled = yield* calls
              .cancelForRun(call.runId, now(), "caller run ended")
              .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<HumanCall>));
            yield* cancelAndDeliver(cancelled);
            continue;
          }
          yield* writeState(workspaceId, call.runId, stateOf(call));
        }
        const settled = yield* calls
          .recentlySettled(workspaceId, now() - REDELIVERY_WINDOW_MS)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<HumanCall>));
        for (const call of settled) {
          const target = statePath(channelOf(workspaceId, call.runId), call.id);
          const present = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true));
          if (!present) yield* writeState(workspaceId, call.runId, stateOf(call));
        }
      });

      const expireDue = Effect.gen(function* () {
        const due = yield* calls.due(now()).pipe(Effect.orElseSucceed(() => []));
        for (const call of due) {
          // An accepted reservation whose input never arrived is cancelled: the
          // callee never saw a question, so no default answer is fabricated.
          const settled = yield* calls
            .settle({
              workspaceId: call.workspaceId,
              id: call.id,
              state: call.state === "accepted" ? "cancelled" : "expired",
              from: call.state === "accepted" ? "accepted" : "pending",
              at: now(),
              detail:
                call.state === "accepted"
                  ? "input not delivered before the deadline"
                  : call.onTimeout === "default_answer"
                    ? "timeout delivered the default answer"
                    : "timeout reached with no answer",
              ...(call.state === "pending" &&
              call.onTimeout === "default_answer" &&
              call.defaultAnswer !== null
                ? { defaultAnswer: call.defaultAnswer }
                : {}),
            })
            .pipe(Effect.option);
          if (Option.isSome(settled))
            yield* writeState(call.workspaceId, call.runId, stateOf(settled.value));
        }
      });

      const tick = Effect.gen(function* () {
        if (options.stateDir === "") return;
        yield* Effect.forEach(
          options.workspaceIds,
          (workspaceId) =>
            scanWorkspace(workspaceId).pipe(
              Effect.andThen(reconcileWorkspace(workspaceId)),
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

      return HumanCallRelay.of({
        tick: Effect.fn("HumanCallRelay.tick")(() => tick),
        deliver: Effect.fn("HumanCallRelay.deliver")((call) =>
          writeState(call.workspaceId, call.runId, stateOf(call)),
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
