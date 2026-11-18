import * as Config from "effect/Config";

export type RelayDatabaseMode = "shared-database" | "stage-branch";

export function relayDatabaseMode(stage: string): RelayDatabaseMode {
  return stage === "prod" ? "shared-database" : "stage-branch";
}

/**
 * Cluster sizing for the retained production database. Defaults match the hosted
 * relay; self-hosted deployments shrink to a single small node through env.
 */
export const relayDatabaseSizing = Config.all({
  clusterSize: Config.String("RELAY_DB_CLUSTER_SIZE").pipe(Config.withDefault("PS_160")),
  replicas: Config.Number("RELAY_DB_REPLICAS").pipe(Config.withDefault(2)),
});
