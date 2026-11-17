import {
  TeamError,
  TeamMember as TeamMemberSchema,
  TeamRole as TeamRoleSchema,
  TeamRpcGroup,
  TeamWorkspaceAccess as TeamWorkspaceAccessSchema,
  teamErrorMessage,
  type TeamErrorRule,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { RpcClientError } from "effect/rpc/RpcClientError";

import { TeamApiError, teamRuleStatus } from "./errors.ts";

export * from "./artifacts.ts";
export * from "./errors.ts";

export type TeamMember = typeof TeamMemberSchema.Type;
export type TeamRole = typeof TeamRoleSchema.Type;
export type TeamWorkspaceAccess = typeof TeamWorkspaceAccessSchema.Type;

const isTeamError = Schema.is(TeamError);
const isTeamApiError = Schema.is(TeamApiError);

/**
 * The team gateway is its own HTTP NDJSON RPC service (`TeamRpcGroup`), separate from the
 * environment the app is connected to. `token` is the bearer access token from `login`.
 */
export interface TeamGatewayConnection {
  /** Gateway origin, for example `http://127.0.0.1:3781`. */
  readonly baseUrl: string;
  readonly token: string | null;
}

const rpcUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/team/rpc`;

const toTeamApiError = (cause: unknown): TeamApiError => {
  if (isTeamApiError(cause)) return cause;
  if (isTeamError(cause)) {
    return new TeamApiError({
      message: teamErrorMessage(cause.rule as TeamErrorRule),
      rule: cause.rule,
      status: teamRuleStatus(cause.rule),
    });
  }
  return new TeamApiError({
    message: cause instanceof Error ? cause.message : String(cause),
    rule: "gateway_unreachable",
    status: 0,
  });
};

type TeamClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof TeamRpcGroup>, RpcClientError>;

/**
 * Runs one `TeamRpcGroup` request against the gateway. The bearer header carries the session;
 * the gateway rejects anything that is not a bearer token.
 */
function request<A>(
  connection: TeamGatewayConnection,
  use: (client: TeamClient) => Effect.Effect<A, TeamError | RpcClientError>,
): Promise<A> {
  const token = connection.token;
  const protocol = RpcClient.layerProtocolHttp({
    url: rpcUrl(connection.baseUrl),
    transformClient: <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
      token === null
        ? client
        : client.pipe(
            HttpClient.mapRequest((httpRequest) =>
              HttpClientRequest.bearerToken(httpRequest, token),
            ),
          ),
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(RpcSerialization.layerNdjson));

  return Effect.runPromise(
    Effect.scoped(Effect.flatMap(RpcClient.make(TeamRpcGroup), use)).pipe(
      Effect.provide(protocol),
      Effect.mapError(toTeamApiError),
    ),
  );
}

/** Exchanges an invitation credential for the bearer token the rest of this module uses. */
export async function login(
  gateway: { readonly baseUrl: string },
  credential: string,
): Promise<string> {
  const result = await request({ baseUrl: gateway.baseUrl, token: null }, (client) =>
    client["team.login"]({ credential }),
  );
  return result.access_token;
}

export function logout(connection: TeamGatewayConnection): Promise<void> {
  return request(connection, (client) => client["team.logout"]());
}

export function listWorkspaces(
  connection: TeamGatewayConnection,
): Promise<ReadonlyArray<TeamWorkspaceAccess>> {
  return request(connection, (client) => client["team.workspaces"]());
}

export function listMembers(
  connection: TeamGatewayConnection,
  workspaceId: string,
): Promise<ReadonlyArray<TeamMember>> {
  return request(connection, (client) => client["team.members"]({ workspaceId }));
}

/** Owner-only. Returns the one-time credential the invited member signs in with. */
export function inviteMember(
  connection: TeamGatewayConnection,
  input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly name: string;
    readonly role: TeamRole;
  },
): Promise<{ readonly credential: string }> {
  return request(connection, (client) => client["team.invite"](input));
}

/** Owner-only. */
export function setMemberRole(
  connection: TeamGatewayConnection,
  input: { readonly workspaceId: string; readonly userId: string; readonly role: TeamRole },
): Promise<void> {
  return request(connection, (client) => client["team.setMember"](input));
}

/** Owner-only. */
export function removeMember(
  connection: TeamGatewayConnection,
  input: { readonly workspaceId: string; readonly userId: string },
): Promise<void> {
  return request(connection, (client) => client["team.removeMember"](input));
}
