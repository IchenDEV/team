import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

/**
 * Shared artifacts are served by the environment this app is connected to, so the request uses
 * the app's own session: the same-origin browser cookie, or the desktop shell's bearer token.
 */
export async function teamArtifactRequest() {
  return {
    baseUrl: resolvePrimaryEnvironmentHttpUrl("/").replace(/\/$/, ""),
    authorization: await readDesktopPrimaryBearerToken(),
  };
}
