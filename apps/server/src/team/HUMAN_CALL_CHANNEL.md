# human_call run↔gateway channel protocol (v2)

A sandboxed run has no network and no credential. Its only channel to the gateway
is a **gateway-owned, per-run directory** mounted into that run's container:

```
<stateDir>/workspaces/<ws>/channels/<runId>/
  outbox/   mounted at /channel/outbox  (rw, this run only)
  inbox/    mounted at /channel/inbox   (ro, this run only)
```

No other run of the workspace mounts either directory, and the gateway state
directory (database, tokens) is never mounted. The shared `/workspace` root stays
read-write for artifacts but carries no call files.

## Run-side steps

1. **Reserve.** Write one fixed-name intent to `/channel/outbox/request.json`:

   ```json
   { "to": "alice", "timeoutSeconds": 3600, "onTimeout": "expire", "defaultAnswer": "hold" }
   ```

   `to` is the callee's user id. `timeoutSeconds` (0 = no deadline), `onTimeout`
   (`expire` | `default_answer` | `keep_waiting`) and `defaultAnswer` are optional.
   The intent declares **no call id, no runId and no file names**: the gateway
   derives the caller from the channel's run and reserves the id itself. One
   reservation at a time per run; a second intent before the input arrives is
   rejected with `input_pending`.

2. **Read the acceptance.** Poll `/channel/inbox/<callId>.state.json` for
   `state: "accepted"`. It carries the one-time `token` and the designated
   `inputFile` (`<callId>.input.json`).

3. **Deliver the question.** Write to `/channel/outbox/<inputFile>`:

   ```json
   { "token": "<token>", "question": "Which branch?", "options": ["main", "release/2.4"], "contextLink": "…" }
   ```

   A valid payload consumes the token and turns the call `pending` for the callee.
   Write the file in one step (or write-then-rename within the outbox); a file that
   is still unparseable 2 s after its last modification is rejected, a younger one
   is retried.

4. **Wait for the answer.** Keep polling the same state file until `state` is
   `answered` (`answer`, `answeredBy`), `expired` (`defaulted`, optional default
   `answer`) or `cancelled`. Input rejections arrive beside it as
   `<callId>.error.json` (`reason`, `at`) and never overwrite the live state; an
   intent rejected before reservation arrives as `inbox/rejected.json`.

## Gateway guarantees

- Identity and file location come from the gateway, never from file contents.
- The token is bound to (run, call) and consumed once: a replayed token is
  `token_replayed`, a wrong one `invalid_token`, and another run's outbox can
  never activate the call. An invalid payload leaves the reservation retryable.
- Reads are bounded (`O_NOFOLLOW | O_NONBLOCK`, fstat on the handle, 16 KiB cap);
  symlinks, FIFOs, directories and oversized files are rejected without being
  read through. Every touched entry is settled, garbage is deleted, and per-tick
  and outbox caps bound the work, so no flood can starve a real request.
- Quotas: 3 active calls per caller, 20 reservations per hour, one accepted
  reservation per run. A caller run that ends cancels its calls.
- Every transition and its audit event commit in one transaction; the tick
  re-delivers active state files and recently settled ones, so a crash between a
  transition and its delivery never strands a run.

## Rejection reasons

Intent (`rejected.json`): `callee_not_member`, `callee_is_caller`,
`caller_not_member`, `caller_run_not_running`, `input_pending`,
`rate_limited_pending`, `rate_limited_hourly`, `invalid_json`, `invalid_request`,
`empty_request`, `request_too_large`, `not_a_regular_file`, `unreadable_request`,
`storage_failure`.

Input (`<callId>.error.json`): `invalid_token`, `token_replayed`, `unknown_call`,
`invalid_json`, `invalid_request`, plus the read refusals above.

## Switchover order

The change ships inside the unmerged feature branch (PR #15): migration 101 is
revised in place (adds the `accepted` state and the `token` column), so there is
no production migration. Delivery order:

1. This protocol PR merges into `feat/team-human-call`.
2. The feature PR rebases onto the new head and re-runs its acceptance.
3. The feature PR merges to `main`.

A development database created against the old migration 101 must be reset (the
two `team_human_call*` tables are recreated by the revised migration); runs
started before the upgrade have no channel mount and must be restarted. The RPC
surface (`team.humanCalls`, `team.answerHumanCall`) and the callee inbox are
unchanged.