/**
 * Shared artifacts are served by the environment the app is connected to. With the membership
 * control plane on that same server, the team session is the only credential needed: the same
 * bearer authenticates the artifact route, so one member identity reaches both surfaces.
 */
export async function teamArtifactRequest(
  baseUrl: string,
  token: string,
): Promise<{ readonly baseUrl: string; readonly authorization: string }> {
  return { baseUrl: baseUrl.replace(/\/+$/, ""), authorization: token };
}
