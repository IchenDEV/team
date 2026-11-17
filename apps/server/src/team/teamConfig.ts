import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as TeamControlPlane from "./TeamControlPlane.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamControlPlane.TeamConfig));

// TEAM_CONFIG_FILE names the workspaces this environment serves. Unset means it
// serves none: membership reads still work, while a run or workspace write is
// refused as workspace_not_configured. A set but unreadable file fails startup.
export const load = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const server = yield* ServerConfig.ServerConfig;
  const path = yield* Config.String("TEAM_CONFIG_FILE").pipe(Config.option);
  const config: TeamControlPlane.TeamConfig = Option.isNone(path)
    ? { workspaces: [] }
    : yield* decode(yield* fs.readFileString(path.value));
  return {
    ...config,
    sandboxStateDir: config.sandboxStateDir ?? `${server.stateDir}/team-sandbox`,
  };
});
