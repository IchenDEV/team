# Upstream integration blocked

Base: `4054d69e44c8a02289adf095560e62c60593e0bd`

Upstream: `f92c5e8f98246ea5537e3ea002fb7bb8ffd84451`

Resolve conflicts or license changes manually. This candidate keeps the fork tree unchanged.

```text
0064bd87f75249b79a568b5d375c46e942c4ea03
100644 26f9a16f8a5d746bfd7802f55666202df10afa66 1	.github/workflows/mobile-eas-preview.yml
100644 f7cbb525a9073d31d8cca331e5c6a4239cea040b 2	.github/workflows/mobile-eas-preview.yml
100644 53061f25e9c4894c8a7b1c83588ce4c821bd5611 3	.github/workflows/mobile-eas-preview.yml
100644 cdabb1e4b7ca3e349b065a99af504d428aa7df86 1	.github/workflows/mobile-eas-production.yml
100644 fc54ffeea54aacc67e416dded382928075a8f7e0 2	.github/workflows/mobile-eas-production.yml
100644 fe4d7456acdf4e0ceb9bfe10a3fcfc5cccbd6084 3	.github/workflows/mobile-eas-production.yml
100644 332c1befe18baa8ed7f9271ba96691cb2bbb2258 1	apps/mobile/src/features/layout/workspace/ListSearchToolbar.android.tsx
100644 fea4a2fbc38c20e175b4800179424bbf428d0fd1 2	apps/mobile/src/features/layout/workspace/ListSearchToolbar.android.tsx
100644 b41008430c1abbfc3a0268cbb636642d850a3f61 3	apps/mobile/src/features/layout/workspace/ListSearchToolbar.android.tsx
100644 e96bf422842e74b3eb12e910a880f765d050e79d 1	apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.tsx
100644 57b7f52c22d0f453e21afe426061e51c1a01695b 2	apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.tsx
100644 2db99c567f9391732539609fd333ba09259db319 3	apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.tsx
100644 79f558bc2742b0d06e897052f17be0ac9af019c1 1	apps/mobile/src/features/settings/components/SourceControlSignInSection.tsx
100644 98147383564942363925d90020953a4b80d8af2c 2	apps/mobile/src/features/settings/components/SourceControlSignInSection.tsx
100644 ce9af71afa6f05c260ed53b2a3bb19dc47e7d736 3	apps/mobile/src/features/settings/components/SourceControlSignInSection.tsx
100644 55c2f67c8c4aa9584415c763dfaf9bde8a00e2bc 1	apps/server/src/persistence/Migrations.ts
100644 450a7df023c9d3cf775301f7b0fde5d5f0a6ee9e 2	apps/server/src/persistence/Migrations.ts
100644 e2c62dd793796085a0c924d6394fc4b317992801 3	apps/server/src/persistence/Migrations.ts
100644 d364fb1185195d6068ac47d82e1202980f2efb69 1	apps/server/src/persistence/reconcileV2PreviewMigration.test.ts
100644 1bbccdfef04d8049be01f29d28e4fdfbc2d963e1 2	apps/server/src/persistence/reconcileV2PreviewMigration.test.ts
100644 fbe47613c87e0f3599a854a7760f99b1aeb44b18 3	apps/server/src/persistence/reconcileV2PreviewMigration.test.ts
100644 dd41ddd2a0213113428c5e8d380172fe2288d65a 1	apps/web/src/components/sidebar/SidebarChrome.tsx
100644 a98a54b22e42b28fc729a53ce3fe26b3860b119c 2	apps/web/src/components/sidebar/SidebarChrome.tsx
100644 3f4b2a6aaf1e2ae6c896e4f3fdad1814e2346d36 3	apps/web/src/components/sidebar/SidebarChrome.tsx
100644 f4ed87e8b5f47421d4dc5010d34c352b8f07e2c4 1	packages/client-runtime/src/connection/diagnosis.ts
100644 c9634a1085fdc6b50153a408904c46f4ed416117 2	packages/client-runtime/src/connection/diagnosis.ts
100644 cd102c08e8723b91a22be37adef9f60358e8235c 3	packages/client-runtime/src/connection/diagnosis.ts
100644 4d313c0ceb98dd348b2fc10b0b6bc1b04867beb5 1	packages/contracts/src/pullRequest.ts
100644 b1ab7adf9f15650791876e2443a0dc487480f271 2	packages/contracts/src/pullRequest.ts
100644 f0e958ce71e7b8c1529e6889fb002f17a5ef7ed3 3	packages/contracts/src/pullRequest.ts

Auto-merging .github/workflows/ci.yml
Auto-merging .github/workflows/mobile-eas-preview-fork.yml
Auto-merging .github/workflows/mobile-eas-preview.yml
CONFLICT (content): Merge conflict in .github/workflows/mobile-eas-preview.yml
Auto-merging .github/workflows/mobile-eas-production.yml
CONFLICT (content): Merge conflict in .github/workflows/mobile-eas-production.yml
Auto-merging apps/desktop/package.json
Auto-merging apps/desktop/src/app/DesktopApp.ts
Auto-merging apps/desktop/src/ssh/DesktopSshEnvironment.ts
Auto-merging apps/desktop/src/telemetry/DesktopTelemetryPublisher.test.ts
Auto-merging apps/mobile/modules/t3-native-controls/ios/T3NativeControls.podspec
Auto-merging apps/mobile/src/features/layout/workspace/ListSearchToolbar.android.tsx
CONFLICT (content): Merge conflict in apps/mobile/src/features/layout/workspace/ListSearchToolbar.android.tsx
Auto-merging apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.tsx
CONFLICT (content): Merge conflict in apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.tsx
Auto-merging apps/mobile/src/features/settings/VoiceModelSection.tsx
Auto-merging apps/mobile/src/features/settings/components/SourceControlSignInSection.tsx
CONFLICT (content): Merge conflict in apps/mobile/src/features/settings/components/SourceControlSignInSection.tsx
Auto-merging apps/mobile/src/features/threads/ThreadComposer.tsx
Auto-merging apps/mobile/src/features/threads/ThreadFeed.tsx
Auto-merging apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx
Auto-merging apps/mobile/src/features/threads/ThreadQueueControl.tsx
Auto-merging apps/mobile/src/state/use-thread-composer-state.ts
Auto-merging apps/server/package.json
Auto-merging apps/server/src/auth/EnvironmentAuth.test.ts
Auto-merging apps/server/src/auth/EnvironmentAuth.ts
Auto-merging apps/server/src/auth/McpOAuth.ts
Auto-merging apps/server/src/background/KeepAwake.ts
Auto-merging apps/server/src/cli/install.test.ts
Auto-merging apps/server/src/cli/thread.ts
Auto-merging apps/server/src/cli/uninstall.ts
Auto-merging apps/server/src/cli/update.test.ts
Auto-merging apps/server/src/cli/update.ts
Auto-merging apps/server/src/cloud/ConnectReachability.ts
Auto-merging apps/server/src/cloud/selfUpdate.ts
Auto-merging apps/server/src/mcp/McpHttpServer.ts
Auto-merging apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
Auto-merging apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts
Auto-merging apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
Auto-merging apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts
Auto-merging apps/server/src/orchestration-v2/Orchestrator.ts
Auto-merging apps/server/src/orchestration-v2/ProjectionStore.test.ts
Auto-merging apps/server/src/orchestration-v2/ProjectionStore.ts
Auto-merging apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts
Auto-merging apps/server/src/orchestration-v2/ProviderTurnStartService.ts
Auto-merging apps/server/src/orchestration-v2/runtimeLayer.test.ts
Auto-merging apps/server/src/peer/PeerLinks.test.ts
Auto-merging apps/server/src/persistence/Migrations.ts
CONFLICT (content): Merge conflict in apps/server/src/persistence/Migrations.ts
Auto-merging apps/server/src/persistence/reconcileV2PreviewMigration.test.ts
CONFLICT (content): Merge conflict in apps/server/src/persistence/reconcileV2PreviewMigration.test.ts
Auto-merging apps/server/src/policy/managedProviders.ts
Auto-merging apps/server/src/provider/AntigravityInstallation.ts
Auto-merging apps/server/src/provider/AntigravityProvider.ts
Auto-merging apps/server/src/provider/CodexInstallation.ts
Auto-merging apps/server/src/provider/CodexProvider.ts
Auto-merging apps/server/src/provider/ProviderRegistry.test.ts
Auto-merging apps/server/src/pullRequest/PullRequestService.test.ts
Auto-merging apps/server/src/server.ts
Auto-merging apps/server/src/speech/native.test.ts
Auto-merging apps/server/src/startupAccess.ts
Auto-merging apps/server/src/terminal/Manager.test.ts
Auto-merging apps/server/src/terminal/Manager.ts
Auto-merging apps/server/src/vcs/GitVcsDriverCore.ts
Auto-merging apps/web/src/components/BranchToolbarBranchSelector.tsx
Auto-merging apps/web/src/components/ChatView.tsx
Auto-merging apps/web/src/components/CommandPalette.tsx
Auto-merging apps/web/src/components/DiffPanel.tsx
Auto-merging apps/web/src/components/RightPanelTabs.tsx
Auto-merging apps/web/src/components/chat/MessagesTimeline.browser.test.tsx
Auto-merging apps/web/src/components/chat/MessagesTimeline.logic.test.ts
Auto-merging apps/web/src/components/chat/QueuedRunsControl.browser.test.tsx
Auto-merging apps/web/src/components/chat/QueuedRunsControl.tsx
Auto-merging apps/web/src/components/chat/RightPanelSurfaceContent.tsx
Auto-merging apps/web/src/components/chat/TimelineUserMessageRow.tsx
Auto-merging apps/web/src/components/pullRequest/PullRequestsPage.tsx
Auto-merging apps/web/src/components/settings/KeybindingsSettings.tsx
Auto-merging apps/web/src/components/settings/SettingsPanels.tsx
Auto-merging apps/web/src/components/settings/ThemeImportDialog.tsx
Auto-merging apps/web/src/components/settings/settingsSearch.ts
Auto-merging apps/web/src/components/sidebar/SidebarChrome.tsx
CONFLICT (content): Merge conflict in apps/web/src/components/sidebar/SidebarChrome.tsx
Auto-merging apps/web/src/index.css
Auto-merging apps/web/test/fakeEnvironment.ts
Auto-merging apps/web/vite.config.ts
Auto-merging packages/client-runtime/src/connection/diagnosis.test.ts
Auto-merging packages/client-runtime/src/connection/diagnosis.ts
CONFLICT (content): Merge conflict in packages/client-runtime/src/connection/diagnosis.ts
Auto-merging packages/client-runtime/src/connection/errors.ts
Auto-merging packages/client-runtime/src/connection/model.ts
Auto-merging packages/client-runtime/src/connection/onboarding.test.ts
Auto-merging packages/client-runtime/src/state/peerPairingCode.ts
Auto-merging packages/client-runtime/src/userMessage.ts
Auto-merging packages/contracts/src/auth.ts
Auto-merging packages/contracts/src/composerContext.ts
Auto-merging packages/contracts/src/index.ts
Auto-merging packages/contracts/src/orchestrationV2.ts
Auto-merging packages/contracts/src/pullRequest.ts
CONFLICT (content): Merge conflict in packages/contracts/src/pullRequest.ts
Auto-merging packages/contracts/src/t3ProjectFile.ts
Auto-merging packages/provider-acp/src/server/adapter.ts
Auto-merging packages/provider-acp/src/server/mcpOverAcpBridge.ts
Auto-merging packages/provider-opencode/src/server/v2/adapter.ts
Auto-merging packages/provider-pi/src/server/adapter.ts

```
