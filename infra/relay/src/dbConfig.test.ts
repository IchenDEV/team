import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { relayDatabaseMode, relayDatabaseSizing } from "./dbConfig.ts";

describe("relayDatabaseMode", () => {
  it("keeps production on the shared database and other stages on branches", () => {
    expect(relayDatabaseMode("prod")).toBe("shared-database");
    expect(relayDatabaseMode("dev_julius")).toBe("stage-branch");
  });
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
