// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type TeamRun } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as TeamHumanCallPersistence from "../persistence/TeamHumanCalls.ts";
import { TeamExecutionBoundary, channelDir } from "./TeamExecutionBoundary.ts";
import {
  HumanCallRelay,
  errorPath,
  inboxDir,
  inputPath,
  intentPath,
  layer as humanCallRelayLayer,
  outboxDir,
  rejectedIntentPath,
  statePath,
  type HumanCallStateFile,
} from "./TeamHumanCalls.ts";

const suffix = `${process.pid}${Math.floor(process.uptime() * 1000) % 100_000}`;
const WORKSPACE = `calls${suffix}`;
const stateDir = `${NodeOS.homedir()}/.t3-team-human-calls-${suffix}`;

// Each run's liveness is independent, so one ended run never masks another's calls.
const runStatuses: Record<string, TeamRun["status"]> = {};
const boundary = Layer.succeed(
  TeamExecutionBoundary,
  TeamExecutionBoundary.of({
    start: () => Effect.void,
    read: (_workspace, runId) =>
      Effect.succeed({
        id: runId,
        nativeRunId: runId,
        status: runStatuses[runId] ?? "running",
        output: [],
      }),
    wait: (runId) =>
      Effect.succeed({ id: runId, nativeRunId: runId, status: "completed", output: [] }),
    cancel: () => Effect.void as never,
    dropWorkspace: () => Effect.void,
    publishArtifact: () => Effect.succeed({ path: "" }),
  }),
);

const clock = { now: Date.parse("2026-11-18T00:00:00.000Z") };

const layer = humanCallRelayLayer({
  stateDir,
  workspaceIds: [WORKSPACE],
  rateLimits: { pending: 3, perHour: 20 },
  clock: () => clock.now,
}).pipe(
  Layer.provideMerge(TeamHumanCallPersistence.layer),
  Layer.provideMerge(TeamMemberships.layer),
  Layer.provideMerge(boundary),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "team-calls-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const runIdOf = (user: string, name: string) => `team.${WORKSPACE}.${user}.${name}`;

const setup = Effect.gen(function* () {
  const members = yield* TeamMemberships.TeamMembershipRepository;
  const calls = yield* TeamHumanCallPersistence.TeamHumanCallRepository;
  const relay = yield* HumanCallRelay;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  for (const id of ["owner", "alice", "bob"])
    yield* members.inviteUser({ id, subject: TeamMemberships.userSubject(id), name: id });
  yield* members.createWorkspace(TeamMemberships.userSubject("owner"), {
    id: WORKSPACE,
    projectId: ProjectId.make(WORKSPACE),
    name: WORKSPACE,
  });
  yield* members.setMember(TeamMemberships.userSubject("owner"), WORKSPACE, "alice", "Editor");
  yield* members.setMember(TeamMemberships.userSubject("owner"), WORKSPACE, "bob", "Editor");

  const channelOf = (runId: string) => channelDir(stateDir, WORKSPACE, runId);
  const prepare = (runId: string) =>
    fs
      .makeDirectory(outboxDir(channelOf(runId)), { recursive: true })
      .pipe(Effect.andThen(fs.makeDirectory(inboxDir(channelOf(runId)), { recursive: true })));
  const readJson = (path: string) =>
    fs.readFileString(path).pipe(
      Effect.map((text) => JSON.parse(text) as Record<string, unknown>),
      Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
    );
  const readState = (runId: string, callId: string) =>
    readJson(statePath(channelOf(runId), callId)) as Effect.Effect<HumanCallStateFile>;
  const readRejection = (runId: string) => readJson(rejectedIntentPath(channelOf(runId)));
  const readError = (runId: string, callId: string) =>
    readJson(errorPath(channelOf(runId), callId));

  // The gateway names the call: a reservation is read back from the accepted state file.
  const reserve = (runId: string, intent: Record<string, unknown>) =>
    Effect.gen(function* () {
      yield* prepare(runId);
      yield* fs.writeFileString(intentPath(channelOf(runId)), JSON.stringify(intent));
      yield* relay.tick();
      const entries = yield* fs.readDirectory(inboxDir(channelOf(runId)));
      for (const entry of entries) {
        if (!entry.endsWith(".state.json")) continue;
        const state = yield* readJson(`${inboxDir(channelOf(runId))}/${entry}`);
        if (state.state === "accepted") return state as unknown as HumanCallStateFile;
      }
      return undefined;
    });
  const submit = (runId: string, callId: string, payload: Record<string, unknown>) =>
    fs
      .writeFileString(inputPath(channelOf(runId), callId), JSON.stringify(payload))
      .pipe(Effect.andThen(relay.tick()), Effect.asVoid);
  const raise = (runId: string, intent: Record<string, unknown>, question: string) =>
    Effect.gen(function* () {
      const accepted = yield* reserve(runId, intent);
      assert.isDefined(accepted, "reservation must be accepted");
      yield* submit(runId, accepted!.callId, { token: accepted!.token, question });
      return accepted!.callId;
    });
  return {
    members,
    calls,
    relay,
    fs,
    sql,
    reserve,
    submit,
    raise,
    readState,
    readRejection,
    readError,
    channelOf,
    prepare,
  };
});

it.effect(
  "a reservation becomes a pending call only under its one-time token, then answers verbatim",
  () =>
    Effect.gen(function* () {
      const { calls, relay, reserve, submit, readState } = yield* setup;
      const runId = runIdOf("bob", "happy");
      const accepted = yield* reserve(runId, {
        to: "alice",
        timeoutSeconds: 3_600,
      });
      assert.isDefined(accepted);
      assert.equal(accepted!.state, "accepted");
      assert.isString(accepted!.token);
      assert.equal(accepted!.inputFile, `${accepted!.callId}.input.json`);
      assert.equal(accepted!.expiresAt, clock.now + 3_600_000);
      // The callee sees nothing until the question arrives under the token.
      assert.equal((yield* calls.pendingForCallee(WORKSPACE, "alice")).length, 0);

      yield* submit(runId, accepted!.callId, {
        token: accepted!.token,
        question: "Which release branch should I cut from?",
        options: ["main", "release/2.4"],
      });
      const pending = yield* readState(runId, accepted!.callId);
      assert.equal(pending.state, "pending");
      assert.equal(pending.question, "Which release branch should I cut from?");
      const inbox = yield* calls.pendingForCallee(WORKSPACE, "alice");
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0]?.id, accepted!.callId);
      assert.equal(inbox[0]?.callerUserId, "bob");
      assert.equal(inbox[0]?.callerName, "bob");
      assert.deepEqual(inbox[0]?.options, ["main", "release/2.4"]);
      // Only the named member is asked: a colleague's inbox stays empty.
      assert.equal((yield* calls.pendingForCallee(WORKSPACE, "owner")).length, 0);

      const answered = yield* calls.answer({
        workspaceId: WORKSPACE,
        id: accepted!.callId,
        calleeUserId: "alice",
        answer: "release/2.4 — main is frozen for the hotfix",
        at: clock.now + 1_000,
      });
      yield* relay.deliver(answered);
      const state = yield* readState(runId, accepted!.callId);
      assert.equal(state.state, "answered");
      assert.equal(state.answer, "release/2.4 — main is frozen for the hotfix");
      assert.equal(state.answeredBy, "alice");
      assert.equal((yield* calls.pendingForCallee(WORKSPACE, "alice")).length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("every state change is audited in one transaction with its event row", () =>
  Effect.gen(function* () {
    const { calls, relay, raise, sql } = yield* setup;
    const runId = runIdOf("bob", "audit");
    const callId = yield* raise(runId, { to: "alice" }, "Audit me?");
    yield* calls.answer({
      workspaceId: WORKSPACE,
      id: callId,
      calleeUserId: "alice",
      answer: "yes",
      at: clock.now + 1,
    });
    yield* relay.tick();
    const events = yield* sql<{ state: string; ordinal: number }>`
      SELECT state, ordinal FROM team_human_call_events WHERE call_id = ${callId} ORDER BY ordinal
    `;
    assert.deepEqual(
      events.map((event) => event.state),
      ["accepted", "pending", "answered"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("a deadline ends the call explicitly, and an undelivered reservation is cancelled", () =>
  Effect.gen(function* () {
    const { calls, relay, raise, reserve, readState } = yield* setup;
    clock.now = Date.parse("2026-11-18T01:00:00.000Z");
    const runId = runIdOf("bob", "timeout");
    const callId = yield* raise(runId, { to: "alice", timeoutSeconds: 120 }, "Ship today?");
    clock.now += 121_000;
    yield* relay.tick();
    const state = yield* readState(runId, callId);
    assert.equal(state.state, "expired");
    assert.equal(state.defaulted, false);
    assert.equal((yield* calls.pendingForCallee(WORKSPACE, "alice")).length, 0);

    // A reservation whose input never arrives reaches the same deadline, as cancelled.
    const accepted = yield* reserve(runIdOf("bob", "timeout-res"), {
      to: "alice",
      timeoutSeconds: 60,
    });
    assert.isDefined(accepted);
    clock.now += 61_000;
    yield* relay.tick();
    const abandoned = yield* readState(runIdOf("bob", "timeout-res"), accepted!.callId);
    assert.equal(abandoned.state, "cancelled");
    assert.equal(abandoned.reason, undefined);
  }).pipe(Effect.provide(layer)),
);

it.effect("a timeout can deliver the declared default answer instead of silence", () =>
  Effect.gen(function* () {
    const { relay, raise, readState } = yield* setup;
    clock.now = Date.parse("2026-11-18T02:00:00.000Z");
    const runId = runIdOf("bob", "default");
    const callId = yield* raise(
      runId,
      { to: "alice", timeoutSeconds: 60, onTimeout: "default_answer", defaultAnswer: "hold" },
      "Ship today?",
    );
    clock.now += 61_000;
    yield* relay.tick();
    const state = yield* readState(runId, callId);
    assert.equal(state.state, "expired");
    assert.equal(state.answer, "hold");
    assert.equal(state.defaulted, true);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a callee outside the workspace, a stale caller run, and a spammer", () =>
  Effect.gen(function* () {
    const { reserve, submit, readRejection, fs, channelOf } = yield* setup;
    clock.now = Date.parse("2026-11-18T03:00:00.000Z");
    const runId = runIdOf("bob", "guards");
    assert.isUndefined(yield* reserve(runId, { to: "dave" }));
    assert.equal((yield* readRejection(runId)).reason, "callee_not_member");

    // A run that already ended cannot raise a call on a member's behalf.
    runStatuses[runId] = "completed";
    yield* reserve(runId, { to: "alice" });
    assert.equal((yield* readRejection(runId)).reason, "caller_run_not_running");
    runStatuses[runId] = "running";

    // One reservation at a time: the input must arrive before the next intent.
    const held = yield* reserve(runId, { to: "alice" });
    assert.isDefined(held);
    yield* reserve(runId, { to: "alice" });
    assert.equal((yield* readRejection(runId)).reason, "input_pending");

    // Alice carries no active call, so her quota starts empty.
    const quotaRun = runIdOf("alice", "rate");
    for (let i = 0; i < 3; i += 1) {
      const accepted = yield* reserve(quotaRun, { to: "bob" });
      assert.isDefined(accepted);
      yield* submit(quotaRun, accepted!.callId, { token: accepted!.token, question: "Again?" });
    }
    yield* reserve(quotaRun, { to: "bob" });
    assert.equal((yield* readRejection(quotaRun)).reason, "rate_limited_pending");
    // The live calls keep their state: a rejection never rewrote them.
    const entries = yield* fs.readDirectory(inboxDir(channelOf(quotaRun)));
    assert.isAtLeast(entries.filter((entry) => entry.endsWith(".state.json")).length, 3);
  }).pipe(Effect.provide(layer)),
);

it.effect("removing a member cancels the calls addressed to them", () =>
  Effect.gen(function* () {
    const { calls, members, relay, raise, readState } = yield* setup;
    clock.now = Date.parse("2026-11-18T04:00:00.000Z");
    const runId = runIdOf("bob", "revoke");
    const callId = yield* raise(runId, { to: "alice" }, "Still there?");
    yield* members.removeMember(TeamMemberships.userSubject("owner"), WORKSPACE, "alice");
    yield* relay.cancelMember(WORKSPACE, "alice");
    const state = yield* readState(runId, callId);
    assert.equal(state.state, "cancelled");
    assert.equal((yield* calls.pendingForCallee(WORKSPACE, "alice")).length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a replayed token is rejected and the live call keeps its state", () =>
  Effect.gen(function* () {
    const { calls, raise, submit, readState, readError, fs, channelOf } = yield* setup;
    clock.now = Date.parse("2026-11-18T05:00:00.000Z");
    const runId = runIdOf("bob", "replay");
    const callId = yield* raise(runId, { to: "alice" }, "First?");
    const accepted = yield* calls.get(WORKSPACE, callId);
    // The consumed token is gone from the row; replaying the input file changes nothing.
    assert.isNull(accepted?.token);
    yield* submit(runId, callId, { token: "replayed-token", question: "Second?" });
    assert.equal((yield* readError(runId, callId)).reason, "token_replayed");
    const state = yield* readState(runId, callId);
    assert.equal(state.state, "pending");
    assert.equal(state.question, "First?");
    assert.isFalse(yield* fs.exists(inputPath(channelOf(runId), callId)));
    assert.equal((yield* calls.pendingForCallee(WORKSPACE, "alice")).length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("a wrong token is rejected, then the right token still works", () =>
  Effect.gen(function* () {
    const { reserve, submit, readState, readError } = yield* setup;
    clock.now = Date.parse("2026-11-18T05:30:00.000Z");
    const runId = runIdOf("bob", "wrong-token");
    const accepted = yield* reserve(runId, { to: "alice" });
    assert.isDefined(accepted);
    yield* submit(runId, accepted!.callId, { token: "not-the-token", question: "Forged?" });
    assert.equal((yield* readError(runId, accepted!.callId)).reason, "invalid_token");
    // The accepted state, token included, is intact: rejection is retryable.
    const stillAccepted = yield* readState(runId, accepted!.callId);
    assert.equal(stillAccepted.state, "accepted");
    assert.equal(stillAccepted.token, accepted!.token);
    yield* submit(runId, accepted!.callId, { token: accepted!.token, question: "Real?" });
    assert.equal((yield* readState(runId, accepted!.callId)).state, "pending");
  }).pipe(Effect.provide(layer)),
);

it.effect("another run's outbox can never activate or read this run's call", () =>
  Effect.gen(function* () {
    const { calls, reserve, submit, readState, readError, fs, channelOf, prepare } = yield* setup;
    clock.now = Date.parse("2026-11-18T06:00:00.000Z");
    const ownerRun = runIdOf("bob", "isolated");
    const accepted = yield* reserve(ownerRun, { to: "alice" });
    assert.isDefined(accepted);
    const row = yield* calls.get(WORKSPACE, accepted!.callId);
    assert.equal(row?.runId, ownerRun);
    assert.isString(row?.token);

    // A peer run of the same member presents the stolen token from its own outbox:
    // the token is bound to the reserving run, so activation refuses it.
    const peerRun = runIdOf("bob", "peer");
    yield* prepare(peerRun);
    yield* submit(peerRun, accepted!.callId, { token: row!.token!, question: "Hijack?" });
    assert.equal((yield* readError(peerRun, accepted!.callId)).reason, "invalid_token");
    // The owner's reservation is untouched and still activatable by its own run.
    const stillAccepted = yield* readState(ownerRun, accepted!.callId);
    assert.equal(stillAccepted.state, "accepted");
    yield* submit(ownerRun, accepted!.callId, {
      token: accepted!.token,
      question: "Private question?",
    });
    const state = yield* readState(ownerRun, accepted!.callId);
    assert.equal(state.state, "pending");
    assert.equal(state.question, "Private question?");

    // Identity comes from the channel, not the file: an intent cannot name another member.
    const aliceRun = runIdOf("alice", "self");
    const aliceAccepted = yield* reserve(aliceRun, { to: "bob", runId: ownerRun });
    assert.isDefined(aliceAccepted);
    const aliceRow = yield* calls.get(WORKSPACE, aliceAccepted!.callId);
    assert.equal(aliceRow?.callerUserId, "alice");
    assert.equal(aliceRow?.runId, aliceRun);
    // The peer's inbox holds no state of the owner's call: channels are per-run trees.
    const peerInbox = yield* fs.readDirectory(inboxDir(channelOf(peerRun)));
    assert.isFalse(peerInbox.includes(`${accepted!.callId}.state.json`));
  }).pipe(Effect.provide(layer)),
);

it.effect("invalid files are settled one by one and never stop the scan or expiry", () =>
  Effect.gen(function* () {
    const { relay, raise, readRejection, readState, fs, channelOf, prepare } = yield* setup;
    clock.now = Date.parse("2026-11-18T07:00:00.000Z");
    const runId = runIdOf("bob", "invalid");
    yield* prepare(runId);
    const outbox = outboxDir(channelOf(runId));
    const age = (path: string) => fs.utimes(path, 0, 0);

    // A symlink, a directory and a FIFO are refused without ever being read through.
    yield* fs.writeFileString(`${outbox}/target.txt`, "{}");
    yield* fs.symlink(`${outbox}/target.txt`, intentPath(channelOf(runId)));
    yield* relay.tick();
    assert.equal((yield* readRejection(runId)).reason, "not_a_regular_file");
    yield* fs.remove(`${outbox}/target.txt`, { force: true });
    yield* fs.makeDirectory(intentPath(channelOf(runId)), { recursive: true });
    yield* relay.tick();
    assert.equal((yield* readRejection(runId)).reason, "not_a_regular_file");
    if ((yield* HostProcess.Platform) !== "win32") {
      NodeChildProcess.execSync(`mkfifo '${intentPath(channelOf(runId))}'`);
      yield* relay.tick();
      assert.equal((yield* readRejection(runId)).reason, "not_a_regular_file");
    }

    // A sparse giant is refused by its size, before any read allocates.
    yield* fs.writeFileString(intentPath(channelOf(runId)), "");
    yield* fs.truncate(intentPath(channelOf(runId)), 1_000_000_000);
    yield* relay.tick();
    assert.equal((yield* readRejection(runId)).reason, "request_too_large");

    // Aged broken JSON and a bad shape are rejected; a young partial write is retried.
    yield* fs.writeFileString(intentPath(channelOf(runId)), "{");
    yield* relay.tick();
    assert.isTrue(yield* fs.exists(intentPath(channelOf(runId))));
    yield* age(intentPath(channelOf(runId)));
    yield* relay.tick();
    assert.equal((yield* readRejection(runId)).reason, "invalid_json");
    yield* fs.writeFileString(intentPath(channelOf(runId)), JSON.stringify({ to: 42 }));
    yield* relay.tick();
    assert.equal((yield* readRejection(runId)).reason, "invalid_request");

    // After every refusal the channel still works, and expiry still runs.
    const callId = yield* raise(runId, { to: "alice", timeoutSeconds: 30 }, "Still alive?");
    clock.now += 31_000;
    yield* relay.tick();
    assert.equal((yield* readState(runId, callId)).state, "expired");
  }).pipe(Effect.provide(layer)),
);

it.effect("garbage and floods cannot starve a real request out of every tick", () =>
  Effect.gen(function* () {
    const { relay, reserve, fs, channelOf, prepare } = yield* setup;
    clock.now = Date.parse("2026-11-18T08:00:00.000Z");
    const runId = runIdOf("bob", "flood");
    yield* prepare(runId);
    const outbox = outboxDir(channelOf(runId));
    // Decoy names that fail the id pattern, settled artifacts, and plain garbage.
    for (let i = 0; i < 300; i += 1)
      yield* fs.writeFileString(`${outbox}/${String(i).padStart(4, "0")}.json.rejected`, "x");
    for (const name of ["a.b.json", ".json", `${"n".repeat(70)}.input.json`])
      yield* fs.writeFileString(`${outbox}/${name}`, "x");
    const accepted = yield* reserve(runId, { to: "alice" });
    assert.isDefined(accepted);
    // Two ticks drain the garbage cap; nothing permanent occupies the window.
    yield* relay.tick();
    const left = yield* fs.readDirectory(outbox);
    assert.isAtMost(left.length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("a crash between a transition and its delivery never strands the run", () =>
  Effect.gen(function* () {
    const { calls, relay, raise, reserve, readState, fs, channelOf } = yield* setup;
    clock.now = Date.parse("2026-11-18T09:00:00.000Z");
    const runId = runIdOf("bob", "crash");
    const callId = yield* raise(runId, { to: "alice" }, "Recover me?");
    const target = statePath(channelOf(runId), callId);
    // The state file is lost after the DB transition: the next tick re-delivers it.
    yield* fs.remove(target);
    yield* relay.tick();
    assert.equal((yield* readState(runId, callId)).state, "pending");

    // An accepted reservation re-delivers its token the same way.
    const resRun = runIdOf("bob", "crash-res");
    const accepted = yield* reserve(resRun, { to: "alice" });
    assert.isDefined(accepted);
    yield* fs.remove(statePath(channelOf(resRun), accepted!.callId));
    yield* relay.tick();
    const redelivered = yield* readState(resRun, accepted!.callId);
    assert.equal(redelivered.state, "accepted");
    assert.equal(redelivered.token, accepted!.token);

    // A terminal state missed by a crash is re-delivered inside the window.
    const answered = yield* calls.answer({
      workspaceId: WORKSPACE,
      id: callId,
      calleeUserId: "alice",
      answer: "recovered",
      at: clock.now + 1,
    });
    yield* relay.deliver(answered);
    yield* fs.remove(target);
    yield* relay.tick();
    const terminal = yield* readState(runId, callId);
    assert.equal(terminal.state, "answered");
    assert.equal(terminal.answer, "recovered");
  }).pipe(Effect.provide(layer)),
);

it.effect("an ended caller run cancels its calls and frees the quota", () =>
  Effect.gen(function* () {
    const { calls, relay, raise, readState } = yield* setup;
    clock.now = Date.parse("2026-11-18T10:00:00.000Z");
    const runId = runIdOf("bob", "ended");
    const callId = yield* raise(runId, { to: "alice" }, "Anyone there?");
    runStatuses[runId] = "completed";
    yield* relay.tick();
    assert.equal((yield* readState(runId, callId)).state, "cancelled");
    assert.equal((yield* calls.pendingForCallee(WORKSPACE, "alice")).length, 0);
    // The dead run no longer holds a pending slot for its member.
    assert.equal(yield* calls.countActive(WORKSPACE, "bob"), 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a rejected intent never rewrites a live call's state file", () =>
  Effect.gen(function* () {
    const { relay, raise, readState, fs, channelOf } = yield* setup;
    clock.now = Date.parse("2026-11-18T11:00:00.000Z");
    const runId = runIdOf("bob", "live-state");
    const callId = yield* raise(runId, { to: "alice" }, "Live?");
    // A later intent that would be rejected lands in its own file, not the call's state.
    yield* fs.writeFileString(intentPath(channelOf(runId)), JSON.stringify({ to: "dave" }));
    yield* relay.tick();
    const state = yield* readState(runId, callId);
    assert.equal(state.state, "pending");
    assert.equal(state.question, "Live?");
  }).pipe(Effect.provide(layer)),
);

it.effect("deleting the workspace cancels accepted and pending calls alike", () =>
  Effect.gen(function* () {
    const { relay, raise, reserve, readState } = yield* setup;
    clock.now = Date.parse("2026-11-18T12:00:00.000Z");
    const runId = runIdOf("bob", "drop");
    const callId = yield* raise(runId, { to: "alice" }, "Before the drop?");
    const accepted = yield* reserve(runIdOf("bob", "drop-res"), { to: "alice" });
    assert.isDefined(accepted);
    yield* relay.cancelWorkspace(WORKSPACE, "workspace deleted");
    assert.equal((yield* readState(runId, callId)).state, "cancelled");
    assert.equal(
      (yield* readState(runIdOf("bob", "drop-res"), accepted!.callId)).state,
      "cancelled",
    );
  }).pipe(Effect.provide(layer)),
);
