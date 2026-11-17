import { createFileRoute } from "@tanstack/react-router";
import { TeamSettings } from "../components/settings/TeamSettings";

function SettingsTeamRoute() {
  return <TeamSettings />;
}

export const Route = createFileRoute("/_chat/settings/team")({
  component: SettingsTeamRoute,
});
