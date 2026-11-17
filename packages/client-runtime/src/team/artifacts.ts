import { TeamApiError } from "./errors.ts";

/**
 * Member-facing artifact shape of the environment HTTP route, with the preview/download paths
 * the server builds. Host storage keys and source URLs never reach the client.
 */
export interface TeamArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly ownerUserId: string | null;
  readonly ownerName: string | null;
  readonly name: string;
  readonly visibility: "workspace" | "private";
  readonly version: number;
  readonly sizeBytes: number;
  readonly mimeType: string | null;
  readonly run: { readonly threadId: string; readonly ref?: string } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly previewPath: string;
  readonly downloadPath: string;
}

export const TEAM_ARTIFACTS_PATH = "/api/team/workspaces";

export const teamArtifactsPath = (workspaceId: string): string =>
  `${TEAM_ARTIFACTS_PATH}/${encodeURIComponent(workspaceId)}/artifacts`;

/** Absolute URL for a `previewPath`/`downloadPath` the artifact route returned. */
export const teamArtifactUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

const readErrorRule = (body: unknown, status: number): string =>
  typeof body === "object" && body !== null && "error" in body
    ? String((body as { error: unknown }).error)
    : `http_${status}`;

export interface TeamArtifactRequest {
  /** Origin of the environment server that owns the artifact route. */
  readonly baseUrl: string;
  readonly workspaceId: string;
  /** Team session bearer; the same identity the member list uses. */
  readonly authorization?: string | null;
  readonly fetchImpl?: typeof fetch;
}

async function artifactRequest<A>(input: TeamArtifactRequest, path: string): Promise<A> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const authorization = input.authorization ?? null;
  const response = await fetchImpl(`${input.baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "GET",
    credentials: authorization === null ? "include" : "omit",
    headers: authorization === null ? {} : { authorization: `Bearer ${authorization}` },
  });
  if (!response.ok) {
    // A packaged server answers unknown paths with the app shell, so only JSON carries a rule.
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? ((await response.json().catch(() => null)) as unknown)
      : null;
    const rule = readErrorRule(body, response.status);
    throw new TeamApiError({
      message: `Team artifact request failed: ${rule} (${response.status})`,
      rule,
      status: response.status,
    });
  }
  return (await response.json()) as A;
}

/**
 * Content of one artifact, authenticated with the member's own session. Navigations cannot carry
 * the bearer, so the caller turns this blob into an object URL for open or download.
 */
export async function fetchArtifactContent(input: {
  readonly baseUrl: string;
  readonly path: string;
  readonly authorization: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<Blob> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(teamArtifactUrl(input.baseUrl, input.path), {
    method: "GET",
    credentials: "omit",
    headers: { authorization: `Bearer ${input.authorization}` },
  });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? ((await response.json().catch(() => null)) as unknown)
      : null;
    const rule = readErrorRule(body, response.status);
    throw new TeamApiError({
      message: `Team artifact request failed: ${rule} (${response.status})`,
      rule,
      status: response.status,
    });
  }
  return await response.blob();
}

export async function listArtifacts(
  input: TeamArtifactRequest,
): Promise<ReadonlyArray<TeamArtifact>> {
  const body = await artifactRequest<{ artifacts: TeamArtifact[] }>(
    input,
    teamArtifactsPath(input.workspaceId),
  );
  return body.artifacts;
}
