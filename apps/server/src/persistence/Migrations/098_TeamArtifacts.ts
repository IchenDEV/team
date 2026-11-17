import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE team_artifacts (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
      workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      -- No foreign key on purpose: an owner missing from team_users stays a valid,
      -- permanently private row instead of a rejected or dangling insert.
      owner_user_id TEXT,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
      visibility TEXT NOT NULL CHECK(visibility IN ('workspace', 'private')),
      version INTEGER NOT NULL CHECK(version >= 1),
      -- Relative key below the team artifacts directory; absolute paths never persist.
      storage_key TEXT,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      mime_type TEXT,
      -- An upstream link is provenance only; it is never returned to a member.
      source_url TEXT,
      run_thread_id TEXT,
      run_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`CREATE INDEX team_artifacts_workspace ON team_artifacts(workspace_id, id)`;
});
