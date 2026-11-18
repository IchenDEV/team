import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

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

/**
 * Local Postgres origin for self-hosted `alchemy dev` runs, parsed from
 * RELAY_DEV_DATABASE_URL. Hyperdrive uses it as the dev origin; local mode
 * never provisions the live config.
 */
export const relayDevDatabaseOrigin = Config.schema(Schema.URL, "RELAY_DEV_DATABASE_URL").pipe(
  Config.map((url) => ({
    scheme: "postgres" as const,
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.replace(/^\//u, "") || "postgres",
    user: decodeURIComponent(url.username),
    password: Redacted.make(decodeURIComponent(url.password)),
    sslmode: "disable" as const,
  })),
);
