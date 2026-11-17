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

/** The session or the membership behind it is gone; cached workspace rows must not stay visible. */
export function isMembershipRevocation(error: unknown): boolean {
  return (
    isTeamApiError(error) &&
    (error.rule === "workspace_membership_required" ||
      error.rule === "authentication_required" ||
      error.rule === "invited_user_required")
  );
}
