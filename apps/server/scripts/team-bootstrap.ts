import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TeamControlPlane from "../src/team/TeamControlPlane.ts";
import * as TeamRuntime from "../src/team/TeamRuntime.ts";
import * as TeamMemberships from "../src/persistence/TeamMemberships.ts";
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServerConfig from "../src/config.ts";
import * as ServerOwnership from "../src/serverOwnership.ts";
import { resolveCliAuthConfig } from "../src/cli/config.ts";

const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(TeamControlPlane.TeamConfig));
const encodeInvitation = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);

// One-shot: seed the first Owner and workspace in this environment's own store and
// write the Owner's one-time credential. Runs while the environment server is
// stopped, because it holds the same ownership lock the server does.
const program = Effect.gen(function* () {
  const [configPath, home, invitationPath] = process.argv.slice(2);
  if (!configPath || !home || !invitationPath)
    return yield* Effect.die(
      new Error("Usage: team-bootstrap.ts CONFIG.json ENVIRONMENT_HOME INVITATION.json"),
    );
  const fs = yield* FileSystem.FileSystem;
  const config = yield* decodeConfig(yield* fs.readFileString(configPath));
  const serverConfig = yield* resolveCliAuthConfig(
    { baseDir: Option.some(home) },
    Option.some("Error"),
  );
  const services = TeamRuntime.layer(config).pipe(
    Layer.provideMerge(ServerConfig.layer(serverConfig)),
  );
  return yield* Effect.gen(function* () {
    yield* ServerOwnership.holdServerOwnershipLock(serverConfig.serverRuntimeStatePath);
    const members = yield* TeamMemberships.TeamMembershipRepository;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const users = yield* sql`SELECT id FROM team_users LIMIT 1`;
        if (users.length)
          return yield* Effect.die(
            new Error("Team is already initialized; an Owner must invite members through RPC."),
          );
        yield* members.inviteUser({
          id: "owner",
          subject: TeamControlPlane.userSubject("owner"),
          name: "Owner",
        });
        const workspace = config.workspaces[0];
        if (!workspace)
          return yield* Effect.die(new Error("Bootstrap requires one configured workspace."));
        yield* members.createWorkspace(TeamControlPlane.userSubject("owner"), {
          id: workspace.id,
          projectId: workspace.projectId,
          name: workspace.id,
        });
        const invitation = yield* auth.createPairingLink({
          subject: TeamControlPlane.userSubject("owner"),
          scopes: ["orchestration:read"],
        });
        yield* fs.writeFileString(
          invitationPath,
          yield* encodeInvitation({ credential: invitation.credential }),
          { flag: "wx", mode: 0o600 },
        );
      }),
    );
  }).pipe(Effect.provide(services));
});
NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
  ),
);
