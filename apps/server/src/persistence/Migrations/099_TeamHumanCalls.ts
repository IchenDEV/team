import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE team_human_calls (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
      workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
      run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 256),
      caller_user_id TEXT NOT NULL REFERENCES team_users(id),
      callee_user_id TEXT NOT NULL REFERENCES team_users(id),
      question TEXT NOT NULL CHECK(length(question) BETWEEN 1 AND 2000),
      options TEXT NOT NULL CHECK(json_valid(options) AND json_type(options) = 'array'),
      context_link TEXT CHECK(context_link IS NULL OR length(context_link) BETWEEN 1 AND 2048),
      state TEXT NOT NULL CHECK(state IN ('pending', 'answered', 'expired', 'cancelled')),
      on_timeout TEXT NOT NULL CHECK(on_timeout IN ('expire', 'default_answer', 'keep_waiting')),
      default_answer TEXT CHECK(default_answer IS NULL OR length(default_answer) BETWEEN 1 AND 4000),
      expires_at INTEGER,
      raised_at INTEGER NOT NULL,
      settled_at INTEGER,
      answer TEXT CHECK(answer IS NULL OR length(answer) BETWEEN 1 AND 4000),
      answered_by TEXT REFERENCES team_users(id),
      CHECK(caller_user_id <> callee_user_id)
    )
  `;
  yield* sql`
    CREATE INDEX team_human_calls_inbox
      ON team_human_calls(workspace_id, callee_user_id, state, raised_at)
  `;
  yield* sql`
    CREATE INDEX team_human_calls_pending_deadline
      ON team_human_calls(state, expires_at)
  `;
  yield* sql`CREATE INDEX team_human_calls_run ON team_human_calls(run_id, state)`;
  yield* sql`
    CREATE TABLE team_human_call_events (
      call_id TEXT NOT NULL REFERENCES team_human_calls(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'answered', 'expired', 'cancelled')),
      at INTEGER NOT NULL,
      detail TEXT,
      PRIMARY KEY(call_id, ordinal)
    )
  `;
});
