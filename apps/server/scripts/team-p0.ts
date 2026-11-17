import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NetService from "@t3tools/shared/Net";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer needs a native server constructor.
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter } from "effect/http";
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
const program = Effect.gen(function* () {
  const [configPath, home, mode, invitationPath] = process.argv.slice(2);
  if (!configPath || !home || !["serve", "bootstrap"].includes(mode ?? ""))
    return yield* Effect.die(
      new Error("Usage: team-p0.ts CONFIG.json ISOLATED_HOME serve | bootstrap INVITATION.json"),
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
    if (mode === "bootstrap") {
      if (!invitationPath)
        return yield* Effect.die(new Error("Bootstrap requires a new invitation output path."));
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
    }
    const port = yield* Config.Int("TEAM_PORT").pipe(Config.withDefault(3781));
    return yield* Layer.launch(
      HttpRouter.serve(TeamRuntime.http).pipe(
        Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port })),
      ),
    );
  }).pipe(Effect.provide(services));
});
NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
  ),
);
