import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

/** The environment the app is on: the membership control plane is its own server. */
export const teamEnvironmentUrl = () => resolvePrimaryEnvironmentHttpUrl("/").replace(/\/+$/, "");

/**
 * Shared artifacts are served by the environment the app is connected to. With the membership
 * control plane on that same server, the team session is the only credential needed: the same
 * bearer authenticates the artifact route, so one member identity reaches both surfaces.
 */
export async function teamArtifactRequest(token: string) {
  return {
    baseUrl: resolvePrimaryEnvironmentHttpUrl("/").replace(/\/$/, ""),
    authorization: token,
  };
}
