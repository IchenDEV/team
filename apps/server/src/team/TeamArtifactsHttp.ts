import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { assetFileResponse } from "../http.ts";
import { requestUrl } from "../requestUrl.ts";
import {
  TEAM_ARTIFACT_ID_PATTERN,
  TeamArtifactError,
  TeamArtifactRepository,
  TeamArtifactVisibility,
  type StoreError,
  type TeamArtifact,
} from "./TeamArtifacts.ts";

export const TEAM_ARTIFACTS_ROUTE_PREFIX = "/api/team/workspaces";

const NO_STORE = { "cache-control": "no-store" };
const JSON_MAX_BODY_BYTES = 48 * 1024 * 1024;
const CONTENT_MAX_BYTES = 32 * 1024 * 1024;

const PublishBody = Schema.Struct({
  id: Schema.optionalKey(Schema.String.check(Schema.isPattern(TEAM_ARTIFACT_ID_PATTERN))),
  name: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)),
  visibility: Schema.optionalKey(TeamArtifactVisibility),
  mimeType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  run: Schema.optionalKey(
    Schema.Struct({
      threadId: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)),
      ref: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
    }),
  ),
  sourceUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  contentBase64: Schema.optionalKey(Schema.String),
});
const AclBody = Schema.Struct({ visibility: TeamArtifactVisibility });
const ImportDryRunBody = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
      version: Schema.optionalKey(Schema.Int),
      ownerUserId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
      visibility: Schema.optionalKey(TeamArtifactVisibility),
      mimeType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
      sizeBytes: Schema.optionalKey(Schema.Int),
      sourceUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
      runThreadId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
      runRef: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
    }),
  ).check(Schema.isMaxLength(4096)),
});

const decodePublishBody = Schema.decodeUnknownEffect(PublishBody);
const decodeAclBody = Schema.decodeUnknownEffect(AclBody);
const decodeImportDryRunBody = Schema.decodeUnknownEffect(ImportDryRunBody);

const readJson = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"] ?? "0") > JSON_MAX_BODY_BYTES) {
    return null;
  }
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(JSON_MAX_BODY_BYTES)),
    Effect.orElseSucceed(() => null),
  );
});

const artifactPaths = (workspaceId: string, artifactId: string) => ({
  previewPath: `${TEAM_ARTIFACTS_ROUTE_PREFIX}/${workspaceId}/artifacts/${artifactId}/preview`,
  downloadPath: `${TEAM_ARTIFACTS_ROUTE_PREFIX}/${workspaceId}/artifacts/${artifactId}/download`,
});

const artifactJson = (artifact: TeamArtifact) => ({
  ...artifact,
  ...artifactPaths(artifact.workspaceId, artifact.id),
});

const artifactStatus = (rule: TeamArtifactError["rule"]) =>
  rule === "artifact_not_found" || rule === "artifact_content_unavailable"
    ? 404
    : rule === "artifact_exists"
      ? 409
      : rule === "viewer_write_denied"
        ? 403
        : 400;

const serviceErrors = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, StoreError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      TeamMembershipError: (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: error.rule }, { status: 403, headers: NO_STORE }),
        ),
      TeamArtifactError: (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: error.rule },
            { status: artifactStatus(error.rule), headers: NO_STORE },
          ),
        ),
      PersistenceSqlError: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: "internal" }, { status: 500, headers: NO_STORE }),
        ),
      PersistenceDecodeError: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: "internal" }, { status: 500, headers: NO_STORE }),
        ),
    }),
  );

type RouteAuthError =
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentInternalError;

const authErrors = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, RouteAuthError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  );

const badRequest = HttpServerResponse.jsonUnsafe(
  { error: "invalid_request" },
  { status: 400, headers: NO_STORE },
);
const notFound = HttpServerResponse.jsonUnsafe(
  { error: "artifact_not_found" },
  { status: 404, headers: NO_STORE },
);

/** `<workspaceId>/artifacts[/<id>[/<action>]]`; null when the shape is wrong. */
const parseRoute = (suffix: string) => {
  const segments = suffix.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return "";
    }
  });
  const [workspaceId, resource, artifactId, action, extra] = segments;
  if (
    workspaceId === undefined ||
    !TEAM_ARTIFACT_ID_PATTERN.test(workspaceId) ||
    resource !== "artifacts" ||
    extra !== undefined
  ) {
    return null;
  }
  if (artifactId !== undefined && !TEAM_ARTIFACT_ID_PATTERN.test(artifactId)) {
    return null;
  }
  return { workspaceId, artifactId, action };
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const artifacts = yield* TeamArtifactRepository;

    const authenticate = Effect.fn("TeamArtifactsHttp.authenticate")(function* (
      scope: AuthEnvironmentScope,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
          failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          ),
        ),
        Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
          failEnvironmentInternal("internal_error", error),
        ),
      );
      if (!session.scopes.includes(scope)) {
        return yield* failEnvironmentScopeRequired(scope);
      }
      return session;
    });

    const getRoute = HttpRouter.add(
      "GET",
      `${TEAM_ARTIFACTS_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("team.artifacts.read");
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (Option.isNone(url)) return badRequest;
        const parsed = parseRoute(
          url.value.pathname.slice(`${TEAM_ARTIFACTS_ROUTE_PREFIX}/`.length),
        );
        if (parsed === null) return notFound;

        const session = yield* authenticate(AuthOrchestrationReadScope);
        return yield* Effect.gen(function* () {
          if (parsed.artifactId === undefined) {
            const items = yield* artifacts.list(session.subject, parsed.workspaceId);
            return HttpServerResponse.jsonUnsafe(
              { artifacts: items.map(artifactJson) },
              { headers: NO_STORE },
            );
          }
          if (parsed.action === undefined) {
            const artifact = yield* artifacts.detail(
              session.subject,
              parsed.workspaceId,
              parsed.artifactId,
            );
            return HttpServerResponse.jsonUnsafe(artifactJson(artifact), { headers: NO_STORE });
          }
          if (parsed.action === "preview" || parsed.action === "download") {
            const content = yield* artifacts.openContent(
              session.subject,
              parsed.workspaceId,
              parsed.artifactId,
              parsed.action === "download" ? "download" : "inline",
            );
            return yield* assetFileResponse(
              content,
              request.method === "GET" ? request.headers.range : undefined,
              request.headers["if-range"],
              request.method === "HEAD" ? "HEAD" : "GET",
            ).pipe(
              Effect.orElseSucceed(() =>
                HttpServerResponse.jsonUnsafe(
                  { error: "internal" },
                  { status: 500, headers: NO_STORE },
                ),
              ),
            );
          }
          return notFound;
        }).pipe(serviceErrors);
      }).pipe(authErrors),
    );

    const postRoute = HttpRouter.add(
      "POST",
      `${TEAM_ARTIFACTS_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("team.artifacts.write");
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (Option.isNone(url)) return badRequest;
        const parsed = parseRoute(
          url.value.pathname.slice(`${TEAM_ARTIFACTS_ROUTE_PREFIX}/`.length),
        );
        if (parsed === null) return notFound;

        const session = yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readJson;
        return yield* Effect.gen(function* () {
          if (parsed.artifactId === undefined) {
            const input =
              body === null
                ? null
                : yield* decodePublishBody(body).pipe(Effect.orElseSucceed(() => null));
            if (input === null) return badRequest;
            const content =
              input.contentBase64 === undefined
                ? undefined
                : Buffer.from(input.contentBase64, "base64");
            if (content !== undefined && content.byteLength > CONTENT_MAX_BYTES) {
              return badRequest;
            }
            const artifact = yield* artifacts.publish(session.subject, parsed.workspaceId, {
              ...(input.id === undefined ? {} : { id: input.id }),
              name: input.name,
              ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
              ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
              ...(input.run === undefined ? {} : { run: input.run }),
              ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
              ...(content === undefined ? {} : { content }),
            });
            return HttpServerResponse.jsonUnsafe(artifactJson(artifact), {
              status: 201,
              headers: NO_STORE,
            });
          }
          if (parsed.artifactId === "import-dry-run" && parsed.action === undefined) {
            const input =
              body === null
                ? null
                : yield* decodeImportDryRunBody(body).pipe(Effect.orElseSucceed(() => null));
            if (input === null) return badRequest;
            const plan = yield* artifacts.importDryRun(
              session.subject,
              parsed.workspaceId,
              input.entries,
            );
            return HttpServerResponse.jsonUnsafe(plan, { headers: NO_STORE });
          }
          if (parsed.action === "acl") {
            const input =
              body === null
                ? null
                : yield* decodeAclBody(body).pipe(Effect.orElseSucceed(() => null));
            if (input === null) return badRequest;
            const artifact = yield* artifacts.setVisibility(
              session.subject,
              parsed.workspaceId,
              parsed.artifactId,
              input.visibility,
            );
            return HttpServerResponse.jsonUnsafe(artifactJson(artifact), { headers: NO_STORE });
          }
          return notFound;
        }).pipe(serviceErrors);
      }).pipe(authErrors),
    );

    return Layer.mergeAll(getRoute, postRoute);
  }),
);
