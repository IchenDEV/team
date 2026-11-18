import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { relayDatabaseMode, relayDatabaseSizing, relayDevDatabaseOrigin } from "./dbConfig.ts";

describe("relayDatabaseMode", () => {
  it("keeps production on the shared database and other stages on branches", () => {
    expect(relayDatabaseMode("prod")).toBe("shared-database");
    expect(relayDatabaseMode("dev_julius")).toBe("stage-branch");
  });
});

describe("relayDevDatabaseOrigin", () => {
  it.effect("parses the local Postgres URL for self-hosted dev runs", () =>
    Effect.gen(function* () {
      const origin = yield* relayDevDatabaseOrigin;
      expect(origin.scheme).toBe("postgres");
      expect(origin.host).toBe("127.0.0.1");
      expect(origin.port).toBe(5433);
      expect(origin.database).toBe("relay");
      expect(origin.user).toBe("relay");
      expect(Redacted.value(origin.password)).toBe("secret");
      expect(origin.sslmode).toBe("disable");
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            RELAY_DEV_DATABASE_URL: "postgres://relay:secret@127.0.0.1:5433/relay",
          }),
        ),
      ),
    ),
  );

  it.effect("defaults the port and database when the URL omits them", () =>
    Effect.gen(function* () {
      const origin = yield* relayDevDatabaseOrigin;
      expect(origin.port).toBe(5432);
      expect(origin.database).toBe("postgres");
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ RELAY_DEV_DATABASE_URL: "postgres://relay@localhost" }),
        ),
      ),
    ),
  );
});

describe("relayDatabaseSizing", () => {
  it.effect("defaults to the hosted relay sizing", () =>
    Effect.gen(function* () {
      const sizing = yield* relayDatabaseSizing;
      expect(sizing).toEqual({ clusterSize: "PS_160", replicas: 2 });
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
  );

  it.effect("allows a single small node for self-hosted deployments", () =>
    Effect.gen(function* () {
      const sizing = yield* relayDatabaseSizing;
      expect(sizing).toEqual({ clusterSize: "PS_5", replicas: 0 });
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ RELAY_DB_CLUSTER_SIZE: "PS_5", RELAY_DB_REPLICAS: "0" }),
        ),
      ),
    ),
  );
});
