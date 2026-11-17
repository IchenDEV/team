import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE team_users (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
      subject TEXT NOT NULL UNIQUE CHECK(length(subject) BETWEEN 1 AND 256),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256)
    )
  `;
  yield* sql`
    CREATE TABLE team_workspaces (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
      project_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256)
    )
  `;
  yield* sql`
    CREATE TABLE team_memberships (
      workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES team_users(id),
      role TEXT NOT NULL CHECK(role IN ('Owner', 'Editor', 'Viewer')),
      PRIMARY KEY(workspace_id, user_id)
    )
  `;
  yield* sql`CREATE INDEX team_memberships_user ON team_memberships(user_id, workspace_id)`;
});
