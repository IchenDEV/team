import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type TeamRun } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as TeamHumanCallPersistence from "../persistence/TeamHumanCalls.ts";
import { TeamExecutionBoundary, workspaceRoot } from "./TeamExecutionBoundary.ts";
import {
  HumanCallRelay,
  callsDir,
  layer as humanCallRelayLayer,
  requestPath,
  statePath,
} from "./TeamHumanCalls.ts";

const suffix = `${process.pid}${Math.floor(process.uptime() * 1000) % 100_000}`;
const WORKSPACE = `calls${suffix}`;
const stateDir = `${NodeOS.homedir()}/.t3-team-human-calls-${suffix}`;
const root = workspaceRoot(stateDir, WORKSPACE);

const runStatus = { value: "running" as TeamRun["status"] };
const boundary = Layer.succeed(
  TeamExecutionBoundary,
  TeamExecutionBoundary.of({
    start: () => Effect.void,
    read: (_workspace, runId) =>
      Effect.succeed({
        id: runId,
        nativeRunId: runId,
        status: runStatus.value,
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
  root: (workspaceId) => workspaceRoot(stateDir, workspaceId),
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

const setup = Effect.gen(function* () {
  const members = yield* TeamMemberships.TeamMembershipRepository;
  const calls = yield* TeamHumanCallPersistence.TeamHumanCallRepository;
  const relay = yield* HumanCallRelay;
  const fs = yield* FileSystem.FileSystem;
  for (const id of ["owner", "alice", "bob"])
    yield* members.inviteUser({ id, subject: TeamMemberships.userSubject(id), name: id });
  yield* members.createWorkspace(TeamMemberships.userSubject("owner"), {
    id: WORKSPACE,
    projectId: ProjectId.make(WORKSPACE),
    name: WORKSPACE,
  });
  yield* members.setMember(TeamMemberships.userSubject("owner"), WORKSPACE, "alice", "Editor");
  yield* members.setMember(TeamMemberships.userSubject("owner"), WORKSPACE, "bob", "Editor");
  yield* fs.makeDirectory(callsDir(root), { recursive: true });

  const readState = (callId: string) =>
    fs.readFileString(statePath(root, callId)).pipe(Effect.orElseSucceed(() => ""));
  const raise = (callId: string, request: Record<string, unknown>) =>
    fs
      .writeFileString(requestPath(root, callId), JSON.stringify(request))
      .pipe(Effect.andThen(relay.tick()), Effect.asVoid);
  return { members, calls, relay, fs, readState, raise };
});

const runId = `team.${WORKSPACE}.bob.e2e-1`;

it.effect("a named member sees a pending call and answers it verbatim", () =>
  Effect.gen(function* () {
    const { calls, relay, readState, raise } = yield* setup;
    yield* raise("call-happy", {
      runId,
      to: "alice",
      question: "Which release branch should I cut from?",
      options: ["main", "release/2.4"],
      timeoutSeconds: 3_600,
    });
    assert.deepEqual(JSON.parse(yield* readState("call-happy")), {
      callId: "call-happy",
      state: "pending",
      question: "Which release branch should I cut from?",
      expiresAt: clock.now + 3_600_000,
    });
    const inbox = yield* calls.pendingForCallee(WORKSPACE, "alice");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.callerUserId, "bob");
    assert.equal(inbox[0]?.callerName, "bob");
    assert.deepEqual(inbox[0]?.options, ["main", "release/2.4"]);
    // Only the named member is asked: a colleague's inbox stays empty.
    assert.equal((yield* calls.pendingForCallee(WORKSPACE, "owner")).length, 0);

    const answered = yield* calls.answer({
      workspaceId: WORKSPACE,
      id: "call-happy",
      calleeUserId: "alice",
      answer: "release/2.4 — main is frozen for the hotfix",
      at: clock.now + 1_000,
    });
    yield* relay.deliver(answered);
    const state = JSON.parse(yield* readState("call-happy"));
    assert.equal(state.state, "answered");
    assert.equal(state.answer, "release/2.4 — main is frozen for the hotfix");
    assert.equal(state.answeredBy, "alice");
    // The answer belongs to that call only.
    assert.equal((yield* calls.pendingForCallee(WORKSPACE, "alice")).length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a deadline ends the call with an explicit expired state", () =>
  Effect.gen(function* () {
    const { calls, relay, readState, raise } = yield* setup;
    clock.now = Date.parse("2026-11-18T01:00:00.000Z");
    yield* raise("call-timeout", {
      runId: `${runId}-timeout`,
      to: "alice",
      question: "Ship today?",
      timeoutSeconds: 120,
    });
    clock.now += 121_000;
    yield* relay.tick();
    const state = JSON.parse(yield* readState("call-timeout"));
    assert.equal(state.state, "expired");
    assert.equal(state.defaulted, false);
    assert.equal((yield* calls.pendingForCallee(WORKSPACE, "alice")).length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a timeout can deliver the declared default answer instead of silence", () =>
  Effect.gen(function* () {
    const { relay, readState, raise } = yield* setup;
    clock.now = Date.parse("2026-11-18T02:00:00.000Z");
    yield* raise("call-default", {
      runId: `${runId}-default`,
      to: "alice",
      question: "Ship today?",
      timeoutSeconds: 60,
      onTimeout: "default_answer",
      defaultAnswer: "hold",
    });
    clock.now += 61_000;
    yield* relay.tick();
    const state = JSON.parse(yield* readState("call-default"));
    assert.equal(state.state, "expired");
    assert.equal(state.answer, "hold");
    assert.equal(state.defaulted, true);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a callee outside the workspace, a stale caller run, and a spammer", () =>
  Effect.gen(function* () {
    const { readState, raise } = yield* setup;
    clock.now = Date.parse("2026-11-18T03:00:00.000Z");
    yield* raise("call-outsider", { runId: `${runId}-out`, to: "dave", question: "Hi?" });
    assert.equal(JSON.parse(yield* readState("call-outsider")).reason, "callee_not_member");

    // A run that already ended cannot raise a call on a member's behalf.
    runStatus.value = "completed";
    yield* raise("call-stale", { runId: `${runId}-stale`, to: "alice", question: "Hi?" });
    assert.equal(JSON.parse(yield* readState("call-stale")).reason, "caller_run_not_running");
    runStatus.value = "running";

    for (const id of ["call-a", "call-b", "call-c"])
      yield* raise(id, { runId: `${runId}-rate`, to: "alice", question: "Again?" });
    yield* raise("call-d", { runId: `${runId}-rate`, to: "alice", question: "Again?" });
    assert.equal(JSON.parse(yield* readState("call-d")).reason, "rate_limited_pending");
  }).pipe(Effect.provide(layer)),
);

it.effect("removing a member cancels the calls addressed to them", () =>
  Effect.gen(function* () {
    const { calls, members, relay, readState, raise } = yield* setup;
    clock.now = Date.parse("2026-11-18T04:00:00.000Z");
    yield* raise("call-revoke", {
      runId: `${runId}-revoke`,
      to: "alice",
      question: "Still there?",
    });
    yield* members.removeMember(TeamMemberships.userSubject("owner"), WORKSPACE, "alice");
    yield* relay.cancelMember(WORKSPACE, "alice");
    const state = JSON.parse(yield* readState("call-revoke"));
    assert.equal(state.state, "cancelled");
    assert.equal((yield* calls.pendingForCallee(WORKSPACE, "alice")).length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a duplicate call id is rejected without stopping expiry for everyone", () =>
  Effect.gen(function* () {
    const { fs, relay, readState, raise } = yield* setup;
    clock.now = Date.parse("2026-11-18T05:00:00.000Z");
    const request = { runId: `${runId}-dup`, to: "alice", question: "First?" };
    yield* raise("call-dup", request);
    // A second run writes the same id: the file is rejected, not thrown out of the tick.
    yield* fs.writeFileString(
      requestPath(root, "call-dup"),
      JSON.stringify({ ...request, question: "Second?" }),
    );
    yield* relay.tick();
    assert.equal(JSON.parse(yield* readState("call-dup")).question, "First?");

    // A call raised afterwards still reaches its deadline, so expiry was not blocked.
    yield* raise("call-after-dup", {
      runId: `${runId}-dup-after`,
      to: "alice",
      question: "Later?",
      timeoutSeconds: 30,
    });
    clock.now += 31_000;
    yield* relay.tick();
    assert.equal(JSON.parse(yield* readState("call-after-dup")).state, "expired");
  }).pipe(Effect.provide(layer)),
);
