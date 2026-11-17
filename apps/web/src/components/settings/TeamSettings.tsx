import { useEffect, useState } from "react";

import {
  fetchArtifactContent,
  type TeamArtifact,
  type TeamRole,
} from "@t3tools/client-runtime/team";
import { CopyIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react";

import { requestConfirmDialog } from "../../confirmDialog";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { useTeamStore } from "../../team/teamStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const ROLE_OPTIONS: ReadonlyArray<TeamRole> = ["Owner", "Editor", "Viewer"];

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

function TeamErrorNote({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="px-3 py-2 text-xs text-destructive sm:px-4">
      {message}
    </p>
  );
}

function ConnectSection() {
  const connect = useTeamStore((state) => state.connect);
  const busy = useTeamStore((state) => state.busy);
  const workspacesError = useTeamStore((state) => state.workspacesError);
  const [credential, setCredential] = useState("");
  // The membership plane lives on the environment the app is connected to; there is no other address.
  const environmentUrl = resolvePrimaryEnvironmentHttpUrl("/").replace(/\/+$/, "");

  return (
    <SettingsSection title="Team">
      <form
        className="space-y-3 px-3 py-3 sm:px-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (credential.trim()) void connect(environmentUrl, credential);
        }}
      >
        <p className="text-sm text-muted-foreground">
          Connect to this environment with the invitation credential the workspace Owner gave you.
        </p>
        <p className="truncate text-xs text-muted-foreground">{environmentUrl}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            placeholder="Invitation credential"
            aria-label="Invitation credential"
            type="password"
            className="w-full sm:w-64"
          />
          <Button type="submit" variant="outline" disabled={busy || !credential.trim()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Connect
          </Button>
        </div>
        <TeamErrorNote message={workspacesError} />
      </form>
    </SettingsSection>
  );
}

function SessionSection() {
  const gatewayUrl = useTeamStore((state) => state.gatewayUrl);
  const workspaces = useTeamStore((state) => state.workspaces);
  const currentWorkspaceId = useTeamStore((state) => state.currentWorkspaceId);
  const members = useTeamStore((state) => state.members);
  const disconnect = useTeamStore((state) => state.disconnect);
  const current = workspaces?.find((workspace) => workspace.id === currentWorkspaceId) ?? null;
  const identity =
    current === null
      ? null
      : (members?.find((member) => member.userId === current.userId)?.name ?? current.userId);

  return (
    <SettingsSection
      title="Team"
      headerAction={
        <Button size="xs" variant="ghost-muted" onClick={() => void disconnect()}>
          Disconnect
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs text-muted-foreground sm:px-4">
        <span className="truncate">{gatewayUrl}</span>
        {current !== null ? (
          <span className="truncate">
            {identity} · {current.role}
          </span>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function WorkspaceSection() {
  const workspaces = useTeamStore((state) => state.workspaces);
  const workspacesError = useTeamStore((state) => state.workspacesError);
  const busy = useTeamStore((state) => state.busy);
  const currentWorkspaceId = useTeamStore((state) => state.currentWorkspaceId);
  const selectWorkspace = useTeamStore((state) => state.selectWorkspace);
  const loadWorkspaces = useTeamStore((state) => state.loadWorkspaces);

  return (
    <SettingsSection title="Workspace">
      <div className="space-y-3 px-3 py-3 sm:px-4">
        {workspaces === null && workspacesError === null ? (
          <p className="text-sm text-muted-foreground">Loading workspaces…</p>
        ) : workspaces !== null && workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This member does not belong to a workspace yet.
          </p>
        ) : workspaces !== null ? (
          <Select
            value={currentWorkspaceId ?? ""}
            onValueChange={(value) => selectWorkspace(value === "" ? null : value)}
          >
            <SelectTrigger aria-label="Current workspace">
              <SelectValue placeholder="Select a workspace" />
            </SelectTrigger>
            <SelectPopup>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name} ({workspace.role})
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <TeamErrorNote message={workspacesError} />
        {workspaces === null && workspacesError !== null ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void loadWorkspaces()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Retry
          </Button>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function MembersSection({ role }: { role: TeamRole }) {
  const members = useTeamStore((state) => state.members);
  const membersError = useTeamStore((state) => state.membersError);
  const invite = useTeamStore((state) => state.invite);
  const setMemberRole = useTeamStore((state) => state.setMemberRole);
  const removeMember = useTeamStore((state) => state.removeMember);
  const isOwner = role === "Owner";
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("Viewer");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [issuedCredential, setIssuedCredential] = useState<string | null>(null);

  return (
    <SettingsSection title="Members">
      <div className="px-3 py-3 sm:px-4">
        {members === null ? (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {members.map((member) => (
              <li
                key={member.userId}
                className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-2"
              >
                <span className="min-w-0 flex-1 basis-full truncate text-sm sm:basis-auto">
                  {member.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {isOwner ? (
                    <Select
                      value={member.role}
                      onValueChange={(value) =>
                        void setMemberRole(member.userId, value as TeamRole)
                      }
                    >
                      <SelectTrigger
                        size="xs"
                        aria-label={`Role for ${member.name}`}
                        className="w-24"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {ROLE_OPTIONS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : (
                    <Badge variant="secondary">{member.role}</Badge>
                  )}
                  {isOwner ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => {
                        const message = `Remove ${member.name} from this workspace?`;
                        const confirmed = requestConfirmDialog(message, { variant: "destructive" });
                        if (confirmed === undefined) {
                          if (!window.confirm(message)) return;
                        } else {
                          void confirmed.then((ok) => {
                            if (ok) void removeMember(member.userId);
                          });
                          return;
                        }
                        void removeMember(member.userId);
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <TeamErrorNote message={membersError} />
        {isOwner ? (
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setInviteError(null);
              setIssuedCredential(null);
              void invite({ name: inviteName.trim(), role: inviteRole })
                .then((result) => {
                  if (result) {
                    setInviteName("");
                    setIssuedCredential(result.credential);
                  }
                })
                .catch((error: unknown) =>
                  setInviteError(error instanceof Error ? error.message : String(error)),
                );
            }}
          >
            <Input
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
              placeholder="New member name"
              aria-label="New member name"
              className="w-48"
            />
            <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as TeamRole)}>
              <SelectTrigger size="sm" aria-label="Invitation role" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button type="submit" variant="outline" disabled={!inviteName.trim()}>
              Invite
            </Button>
          </form>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Membership is managed by the workspace Owner.
          </p>
        )}
        <TeamErrorNote message={inviteError} />
        {issuedCredential !== null ? (
          <div className="mt-3 rounded-md border border-border/60 bg-muted/20 p-2">
            <p className="mb-1 text-xs text-muted-foreground">
              Give this one-time credential to the invited member.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-xs">{issuedCredential}</code>
              <Button
                size="xs"
                variant="ghost-muted"
                aria-label="Copy invitation credential"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(issuedCredential)
                    .then(() => toastManager.add({ title: "Invitation credential copied" }));
                }}
              >
                <CopyIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function ArtifactsSection() {
  const artifacts = useTeamStore((state) => state.artifacts);
  const artifactsError = useTeamStore((state) => state.artifactsError);
  const artifactsUnavailable = useTeamStore((state) => state.artifactsUnavailable);
  const artifactBaseUrl = useTeamStore((state) => state.artifactBaseUrl);
  const token = useTeamStore((state) => state.token);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the preview blob URL held outside React
  useEffect(() => {
    return () => {
      if (preview !== null) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  const closePreview = () => {
    setPreview((current) => {
      if (current !== null) URL.revokeObjectURL(current.url);
      return null;
    });
  };

  // The member session is a bearer, which a plain link cannot carry. Content is fetched with it:
  // preview renders in a sandboxed frame (never a top-level navigation), download saves the blob.
  const openArtifact = (artifact: TeamArtifact, mode: "open" | "download") => {
    if (token === null || artifactBaseUrl === null) return;
    void fetchArtifactContent({
      baseUrl: artifactBaseUrl,
      path: mode === "open" ? artifact.previewPath : artifact.downloadPath,
      authorization: token,
    })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (mode === "open") {
          setPreview((current) => {
            if (current !== null) URL.revokeObjectURL(current.url);
            return { name: artifact.name, url };
          });
          return;
        }
        const link = document.createElement("a");
        link.href = url;
        link.download = artifact.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch((error: unknown) => {
        toastManager.add({
          title: `Could not ${mode} ${artifact.name}`,
          description: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const content = (() => {
    if (artifactsUnavailable) {
      return (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          Shared artifacts are not available on this environment yet.
        </p>
      );
    }
    if (artifacts === null && artifactsError === null)
      return <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">Loading artifacts…</p>;
    if (artifacts === null) return null;
    if (artifacts.length === 0) {
      return (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
          No shared artifacts in this workspace yet.
        </p>
      );
    }
    return (
      <ul className="divide-y divide-border/50">
        {artifacts.map((artifact: TeamArtifact) => (
          <li key={artifact.id} className="flex items-center gap-3 px-3 py-2 sm:px-4">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{artifact.name}</span>
              <span className="block text-xs text-muted-foreground">
                {formatBytes(artifact.sizeBytes)}
                {artifact.ownerName ? ` · ${artifact.ownerName}` : ""}
                {artifact.run ? ` · run ${artifact.run.threadId}` : ""}
                {artifact.visibility === "private" ? " · private" : ""}
              </span>
            </span>
            <Badge variant="secondary">v{artifact.version}</Badge>
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={`Open ${artifact.name}`}
              onClick={() => openArtifact(artifact, "open")}
            >
              <ExternalLinkIcon className="size-4" />
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={`Download ${artifact.name}`}
              onClick={() => openArtifact(artifact, "download")}
            >
              <DownloadIcon className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    );
  })();

  return (
    <SettingsSection title="Shared artifacts">
      {content}
      <TeamErrorNote message={artifactsError} />
      {preview !== null ? (
        <div className="space-y-2 px-3 py-3 sm:px-4">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm">{preview.name}</span>
            <Button size="xs" variant="ghost-muted" onClick={closePreview}>
              Close
            </Button>
          </div>
          {/* Sandboxed: artifact content runs on an opaque origin, never on the app origin. */}
          <iframe
            title={`Preview of ${preview.name}`}
            src={preview.url}
            sandbox="allow-scripts"
            className="h-80 w-full rounded-md border border-border/60 bg-background"
          />
        </div>
      ) : null}
    </SettingsSection>
  );
}

export function TeamSettings() {
  const token = useTeamStore((state) => state.token);
  const workspaces = useTeamStore((state) => state.workspaces);
  const currentWorkspaceId = useTeamStore((state) => state.currentWorkspaceId);
  const loadWorkspaces = useTeamStore((state) => state.loadWorkspaces);
  const currentWorkspace =
    workspaces?.find((workspace) => workspace.id === currentWorkspaceId) ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the gateway state this page shows
  useEffect(() => {
    if (token === null) return;
    void loadWorkspaces().then(() => {
      const state = useTeamStore.getState();
      if (state.currentWorkspaceId !== null) {
        void state.loadMembers();
        void state.loadArtifacts();
      }
    });
  }, [token, loadWorkspaces]);

  return (
    <SettingsPageContainer>
      {token === null ? (
        <ConnectSection />
      ) : (
        <>
          <SessionSection />
          <WorkspaceSection />
          {currentWorkspace !== null ? (
            <>
              <MembersSection role={currentWorkspace.role} />
              <ArtifactsSection />
            </>
          ) : null}
        </>
      )}
    </SettingsPageContainer>
  );
}
