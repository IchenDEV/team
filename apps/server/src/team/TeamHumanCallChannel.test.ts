// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, TeamRpcGroup } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as TeamMemberships from "../persistence/TeamMemberships.ts";
import * as TeamHumanCallPersistence from "../persistence/TeamHumanCalls.ts";
import * as TeamControlPlane from "./TeamControlPlane.ts";
import * as TeamRuntime from "./TeamRuntime.ts";
import { TeamExecutionBoundary, channelDir } from "./TeamExecutionBoundary.ts";
import { inboxDir, intentPath, statePath } from "./TeamHumanCalls.ts";

/**
 * Real integration path: a sandboxed Docker run reserves a call through its
 * private outbox, the gateway tick loop issues the one-time token, a member
 * answers over real HTTP NDJSON RPC, and the run resumes with the answer.
 */
const suffix = Buffer.from(SecureRandom.randomBytesUnsafe(3)).toString("hex");

// Each test owns its workspace, state dir and database: a shared file DB would
// carry one test's calls and revocation markers into the next.
const makeEnv = (label: string) => {
  const WS = `hc${label}${suffix}`;
  const stateDir = `${NodeOS.homedir()}/.t3-team-human-call-channel-${suffix}-${label}`;
  const config: TeamControlPlane.TeamConfig = {
    sandboxStateDir: stateDir,
    workspaces: [
      {
        id: WS,
        projectId: ProjectId.make(WS),
        modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "todo-list" },
        credentials: {},
        networkMode: "none",
      },
    ],
  };
  const appLayer = TeamRuntime.layer(config).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: `team-hc-${suffix}-${label}-` })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const httpLayer = HttpRouter.serve(TeamRuntime.http, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.provideMerge(appLayer), Layer.provideMerge(NodeHttpServer.layerTest));
  return { WS, stateDir, httpLayer };
};

const userSubject = TeamControlPlane.userSubject;

/** Read every state file in a run's inbox as plain JSON (for milestone polls). */
const inboxStates = async (channel: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const entries = await NodeFSP.readdir(inboxDir(channel)).catch(() => [] as string[]);
  const states: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".state.json")) continue;
    states.push(
      JSON.parse(await NodeFSP.readFile(`${inboxDir(channel)}/${entry}`, "utf8")) as Record<
        string,
        unknown
      >,
    );
  }
  return states;
};

/** The run-side protocol, as a busybox script: intent -> token -> input -> final state. */
const callScript = (to: string, timeoutSeconds: number, question: string, waitFinal = true) => `
printf '{"to":"${to}","timeoutSeconds":${timeoutSeconds}}' > /channel/outbox/request.json
TOKEN=""
CALL=""
n=0
while [ -z "$TOKEN" ] && [ "$n" -lt 300 ]; do
  n=$((n+1))
  for f in /channel/inbox/*.state.json; do
    [ -f "$f" ] || continue
    S=$(cat "$f")
    case "$S" in
      *'"state":"accepted"'*)
        TOKEN=$(printf '%s' "$S" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')
        CALL=$(basename "$f" .state.json)
        ;;
    esac
  done
  [ -z "$TOKEN" ] && sleep 1
done
if [ -z "$TOKEN" ]; then echo NO_TOKEN; exit 1; fi
printf '{"token":"%s","question":"${question}"}' "$TOKEN" > "/channel/outbox/$CALL.input.json"
${waitFinal ? "" : "echo SUBMITTED\nexit 0"}
n=0
while [ "$n" -lt 300 ]; do
  n=$((n+1))
  S=$(cat "/channel/inbox/$CALL.state.json" 2>/dev/null || true)
  case "$S" in
    *'"state":"answered"'*|*'"state":"expired"'*|*'"state":"cancelled"'*)
      echo "FINAL:$S"
      exit 0
      ;;
  esac
  sleep 1
done
echo STUCK
exit 1
`;

const setup = ({ WS, stateDir, httpLayer }: ReturnType<typeof makeEnv>) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(httpLayer);
    const server = Context.get(services, HttpServer.HttpServer);
    const baseUrl = NetAddress.formatUrlUnsafe(server.address, "http").replace(
      "0.0.0.0",
      "127.0.0.1",
    );
    const boundary = Context.get(services, TeamExecutionBoundary);
    const members = Context.get(services, TeamMemberships.TeamMembershipRepository);
    const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const calls = Context.get(services, TeamHumanCallPersistence.TeamHumanCallRepository);
    const fs = Context.get(services, FileSystem.FileSystem);
    const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(services));

    yield* Effect.addFinalizer(() =>
      withServices(
        Effect.gen(function* () {
          yield* boundary.dropWorkspace(WS).pipe(Effect.ignore);
          yield* fs.remove(stateDir, { recursive: true, force: true }).pipe(Effect.ignore);
        }),
      ),
    );

    for (const id of ["owner", "alice", "bob"])
      yield* withServices(members.inviteUser({ id, subject: userSubject(id), name: id }));
    yield* withServices(
      members.createWorkspace(userSubject("owner"), {
        id: WS,
        projectId: ProjectId.make(WS),
        name: WS,
      }),
    );
    yield* withServices(members.setMember(userSubject("owner"), WS, "alice", "Editor"));
    yield* withServices(members.setMember(userSubject("owner"), WS, "bob", "Editor"));

    const clientFor = (token: string | null) =>
      RpcClient.make(TeamRpcGroup).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({
            url: `${baseUrl}/team/rpc`,
            transformClient: <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
              token === null
                ? client
                : client.pipe(
                    HttpClient.mapRequest((request) =>
                      HttpClientRequest.bearerToken(request, token),
                    ),
                  ),
          }).pipe(
            Layer.provide(RpcSerialization.layerNdjson),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      );
    const login = (id: string) =>
      Effect.gen(function* () {
        const invitation = yield* withServices(
          auth.createPairingLink({ subject: userSubject(id), scopes: ["orchestration:read"] }),
        );
        const anon = yield* clientFor(null);
        const session = yield* anon["team.login"]({ credential: invitation.credential });
        return yield* clientFor(session.access_token);
      });
    const owner = yield* login("owner");
    const alice = yield* login("alice");
    const bob = yield* login("bob");

    const channelOf = (runId: string) => channelDir(stateDir, WS, runId);
    const fileExists = (path: string) =>
      Effect.promise(() =>
        NodeFSP.access(path).then(
          () => true,
          () => false,
        ),
      );
    const readJson = (path: string) =>
      Effect.promise(() =>
        NodeFSP.readFile(path, "utf8").then(
          (text) => JSON.parse(text) as Record<string, unknown>,
          () => ({}) as Record<string, unknown>,
        ),
      );
    return {
      services,
      boundary,
      calls,
      fs,
      withServices,
      owner,
      alice,
      bob,
      channelOf,
      fileExists,
      readJson,
    };
  });

it.live(
  "a run reserves a call, a member answers over HTTP, and the run resumes with the answer",
  () =>
    Effect.gen(function* () {
      const env = makeEnv("happy");
      const { WS, stateDir } = env;
      const { boundary, calls, alice, bob, channelOf, fileExists, readJson, withServices } =
        yield* setup(env);
      const question = "Which release branch should I cut from?";
      const started = yield* bob["team.start"]({
        workspaceId: WS,
        commandId: "happy",
        text: callScript("alice", 120, question),
      });
      assert.equal(started.status, "running");

      // The gateway's tick loop accepts the intent through the run's private outbox.
      yield* Effect.promise(() =>
        expect
          .poll(
            async () =>
              (await inboxStates(channelOf(started.id))).some((s) => s.state === "pending"),
            { timeout: 60_000, interval: 250 },
          )
          .toBe(true),
      );
      const inbox = yield* withServices(calls.pendingForCallee(WS, "alice"));
      const callId = inbox[0]!.id;
      assert.equal(inbox[0]!.question, question);
      assert.equal(inbox[0]!.callerUserId, "bob");
      assert.equal(inbox[0]!.callerName, "bob");
      assert.equal(inbox[0]!.runId, started.id);
      // The accepted state carried a token; the consumed row no longer holds one.
      const row = yield* withServices(calls.get(WS, callId));
      assert.equal(row?.state, "pending");
      assert.isNull(row?.token);
      const acceptedState = yield* readJson(statePath(channelOf(started.id), callId));
      assert.equal(acceptedState.state, "pending");

      // The member answers over real HTTP RPC; the original run resumes.
      yield* alice["team.answerHumanCall"]({
        workspaceId: WS,
        callId,
        answer: "release/2.4 — main is frozen for the hotfix",
      });
      const done = yield* withServices(boundary.wait(started.id));
      assert.equal(done.status, "completed");
      const read = yield* bob["team.read"]({ workspaceId: WS, runId: started.id });
      const final = read.output.find((line) => line.startsWith("FINAL:"));
      assert.isDefined(final);
      const state = JSON.parse(final!.slice("FINAL:".length)) as Record<string, unknown>;
      assert.equal(state.state, "answered");
      assert.equal(state.answer, "release/2.4 — main is frozen for the hotfix");
      assert.equal(state.answeredBy, "alice");
      assert.equal(state.callId, callId);
      assert.isFalse(yield* fileExists(intentPath(channelOf(started.id))));

      // A peer run of the same workspace sees only its own channel: no sibling
      // state, no gateway database, and its inbox is read-only.
      const peer = yield* bob["team.start"]({
        workspaceId: WS,
        commandId: "peer",
        text: [
          `echo "CHANNEL:$(ls /channel | tr '\n' ' ')"`,
          `echo "INBOX:$(ls /channel/inbox | tr '\n' ' ')"`,
          `if echo x > /channel/inbox/probe.txt 2>/dev/null; then echo INBOX_WRITABLE; else echo INBOX_READONLY; fi`,
          `echo "LEAK:$(find / -name '*.state.json' 2>/dev/null | grep -v '^/channel/inbox/' | head -5)"`,
          `if ls '${stateDir}' >/dev/null 2>&1; then echo STATE_VISIBLE; else echo STATE_HIDDEN; fi`,
          `echo "OUTBOX:$(ls /channel/outbox | tr '\n' ' ')"`,
        ].join("\n"),
      });
      const peerDone = yield* withServices(boundary.wait(peer.id));
      assert.equal(peerDone.status, "completed");
      const peerOut = (yield* bob["team.read"]({ workspaceId: WS, runId: peer.id })).output.join(
        "\n",
      );
      assert.isTrue(peerOut.includes("CHANNEL:inbox outbox"));
      assert.isTrue(peerOut.includes("INBOX:"));
      assert.isFalse(peerOut.includes(`${callId}.state.json`));
      assert.isTrue(peerOut.includes("INBOX_READONLY"));
      assert.isTrue(peerOut.includes("LEAK:"));
      assert.isFalse(peerOut.includes("LEAK:/"));
      assert.isTrue(peerOut.includes("STATE_HIDDEN"));
      assert.isTrue(peerOut.includes("OUTBOX:"));
      assert.isFalse(peerOut.includes("request.json"));
    }).pipe(Effect.scoped),
);

it.live("an unanswered call expires on its deadline and the run reads the explicit state", () =>
  Effect.gen(function* () {
    const env = makeEnv("timeout");
    const { WS } = env;
    const { boundary, bob, withServices } = yield* setup(env);
    const started = yield* bob["team.start"]({
      workspaceId: WS,
      commandId: "timeout",
      // Enough headroom for acceptance and input delivery before the deadline.
      text: callScript("alice", 8, "Ship today?"),
    });
    const done = yield* withServices(boundary.wait(started.id));
    assert.equal(done.status, "completed");
    const read = yield* bob["team.read"]({ workspaceId: WS, runId: started.id });
    const final = read.output.find((line) => line.startsWith("FINAL:"));
    assert.isDefined(final);
    const state = JSON.parse(final!.slice("FINAL:".length)) as Record<string, unknown>;
    assert.equal(state.state, "expired");
    assert.equal(state.defaulted, false);
  }).pipe(Effect.scoped),
);

it.live("removing the callee cancels the call, and an ended caller run never holds a call", () =>
  Effect.gen(function* () {
    const env = makeEnv("cancel");
    const { WS } = env;
    const { boundary, calls, owner, bob, channelOf, readJson, withServices } = yield* setup(env);

    // Member removal reaches the waiting run as an explicit cancelled state.
    const started = yield* bob["team.start"]({
      workspaceId: WS,
      commandId: "cancel",
      text: callScript("alice", 600, "Still there?"),
    });
    yield* Effect.promise(() =>
      expect
        .poll(
          async () => (await inboxStates(channelOf(started.id))).some((s) => s.state === "pending"),
          { timeout: 60_000, interval: 250 },
        )
        .toBe(true),
    );
    const callId = (yield* withServices(calls.pendingForCallee(WS, "alice")))[0]!.id;
    yield* owner["team.removeMember"]({ workspaceId: WS, userId: "alice" });
    const done = yield* withServices(boundary.wait(started.id));
    assert.equal(done.status, "completed");
    const final = (yield* bob["team.read"]({ workspaceId: WS, runId: started.id })).output.find(
      (line) => line.startsWith("FINAL:"),
    );
    assert.isDefined(final);
    assert.equal(
      (JSON.parse(final!.slice("FINAL:".length)) as Record<string, unknown>).state,
      "cancelled",
    );
    const state = yield* readJson(statePath(channelOf(started.id), callId));
    assert.equal(state.state, "cancelled");

    // A caller that ends while its call is pending: the tick cancels it, so the
    // callee's inbox empties and the dead run holds no quota.
    yield* withServices(
      // Re-add alice so a fresh call can address her.
      Effect.gen(function* () {
        const members = yield* TeamMemberships.TeamMembershipRepository;
        yield* members.setMember(userSubject("owner"), WS, "alice", "Editor");
      }),
    );
    const ended = yield* bob["team.start"]({
      workspaceId: WS,
      commandId: "ended",
      text: callScript("alice", 600, "Anyone there?", false),
    });
    yield* withServices(boundary.wait(ended.id));
    // The tick cancels the dead run's call; the terminal state reaches its inbox.
    yield* Effect.promise(() =>
      expect
        .poll(
          async () => (await inboxStates(channelOf(ended.id))).some((s) => s.state === "cancelled"),
          { timeout: 60_000, interval: 250 },
        )
        .toBe(true),
    );
    assert.equal((yield* withServices(calls.pendingForCallee(WS, "alice"))).length, 0);
    assert.equal(yield* withServices(calls.countActive(WS, "bob")), 0);
  }).pipe(Effect.scoped),
);
