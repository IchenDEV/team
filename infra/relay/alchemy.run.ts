// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { defaultProviderMode } from "alchemy/ProviderMode";
import { localState } from "alchemy/State/LocalState";
import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Planetscale from "@alchemy.run/planetscale";

import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { MobileSourceMapsUploadCredentials, RelayObservability } from "./src/observability.ts";
import { isPreviewStage } from "./src/previewStages.ts";
import { PreviewTunnelSweep, PreviewTunnelSweepProvider } from "./src/previewTunnelSweep.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Drizzle.providers(),
      PreviewTunnelSweepProvider(),
      // Local self-host runs have no Axiom or PlanetScale account; skip those
      // providers entirely so their credentials are never required.
      Layer.unwrap(
        Effect.map(defaultProviderMode, (mode) =>
          mode === "local"
            ? Layer.empty
            : Layer.mergeAll(Axiom.providers(), Planetscale.providers()),
        ),
      ),
    ),
    // Local self-host runs keep their state on the machine instead of
    // provisioning a Cloudflare state-store Worker in the account.
    state: Layer.unwrap(
      Effect.map(defaultProviderMode, (mode) =>
        mode === "local" ? localState() : Cloudflare.state(),
      ),
    ),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const db = yield* RelayDb.PlanetscaleDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const mobileSourceMapsUploadCredentials = yield* MobileSourceMapsUploadCredentials;
    const api = yield* RelayWorker.Api;
    if (isPreviewStage(stage)) {
      const { managedEndpointZoneName } = yield* RelayDeploymentConfig;
      yield* PreviewTunnelSweep("PreviewTunnelSweep", {
        stage,
        tunnelZoneName: managedEndpointZoneName,
        workerName: api.workerName,
      });
    }
    yield* PublishClientConfig({
      url: api.url,
      mobileTracingUrl: observability.traces.otelTracesEndpoint,
      mobileTracingDataset: observability.traces.name,
      mobileTracingToken: observability.mobileIngestToken.token,
      clientTracingUrl: observability.traces.otelTracesEndpoint,
      clientTracingDataset: observability.traces.name,
      clientTracingToken: observability.clientIngestToken.token,
      tokenDigest: Output.map(
        Output.all(observability.mobileIngestToken.token, observability.clientIngestToken.token),
        tokenDigest,
      ),
    });

    return {
      databaseName: db.database?.name ?? "local-postgres",
      databaseBranchName: db.branch?.name ?? "main",
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      mobileTracingUrl: observability.traces.otelTracesEndpoint,
      mobileTracingDataset: observability.traces.name,
      mobileTracingToken: observability.mobileIngestToken.token,
      clientTracingUrl: observability.traces.otelTracesEndpoint,
      clientTracingDataset: observability.traces.name,
      clientTracingToken: observability.clientIngestToken.token,
      mobileLogsDataset: observability.mobileLogs.name,
      mobileMetricsDataset: observability.mobileMetrics.name,
      mobileSourceMapsBucket: observability.mobileSourceMaps.bucketName,
      // The MOBILE_SOURCEMAPS_R2 secret for GitHub Actions and EAS Build.
      mobileSourceMapsUploadCredentials,
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
