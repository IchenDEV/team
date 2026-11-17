import * as Schema from "effect/Schema";

/** A member-facing team failure: a server rule, or the transport's status. */
export class TeamApiError extends Schema.TaggedError<TeamApiError>()("TeamApiError", {
  message: Schema.String,
  rule: Schema.String,
  status: Schema.Number,
}) {}

export const isTeamApiError = Schema.is(TeamApiError);

const RULE_STATUS: Readonly<Record<string, number>> = {
  authentication_required: 401,
  workspace_membership_required: 403,
  viewer_execution_forbidden: 403,
  invited_user_required: 403,
  owner_required: 403,
};

export const teamRuleStatus = (rule: string): number => RULE_STATUS[rule] ?? 400;

/** The session itself is gone (logout, expiry, revoked token): no workspace stays reachable. */
export function isSessionLost(error: unknown): boolean {
  return (
    isTeamApiError(error) && (error.rule === "authentication_required" || error.status === 401)
  );
}

/**
 * One workspace or one membership is gone, while the session still works. This is not a logout:
 * the token stays, only that workspace's rows and selection must go.
 */
export function isWorkspaceAccessLost(error: unknown): boolean {
  return (
    isTeamApiError(error) &&
    (error.rule === "workspace_membership_required" || error.rule === "invited_user_required")
  );
}

/** Either kind: the caller must stop showing the rows it was showing. */
export function isMembershipRevocation(error: unknown): boolean {
  return isSessionLost(error) || isWorkspaceAccessLost(error);
}
