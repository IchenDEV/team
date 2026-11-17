# Team 执行环境隔离（一期）

`TeamExecutionBoundary` 为每个经身份认证的工作区绑定独立的执行环境，替代 `TeamControlPlane` 的 `start`/`read` 表面。每个 `team.start` 调用在该工作区专属的容器沙箱中运行（Docker），三个绑定：

- **运行**：`team.<workspace>.<user>.<commandId>` → 同一工作区的专属容器（`--name t3ex-...`，标签 `t3.team.workspace`/`t3.team.run`）。相同命令重放返回同一运行；命令体不同的同 ID 提交返回 `command_conflict`。
- **文件系统根**：`<stateDir>/workspaces/<id>/root`，以读写方式挂载为容器内唯一的 `/workspace`。**项目目录绝不作为沙箱**——根目录由边界独占管理，凭据文件位于挂载树之外。
- **受限环境凭据域**：`<stateDir>/workspaces/<id>/credentials.env`（0600），仅注入该工作区的运行；宿主环境不会泄漏进沙箱。

容器加固：`--network none`（默认，可按工作区配置 `bridge`）、`--read-only` 根文件系统 + `--tmpfs /tmp`、`--cap-drop ALL`、`--security-opt no-new-privileges`、`--pids-limit 64`、`--memory 256m`。

## 失败关闭

没有可用容器运行时（`docker info` 失败）时，`ensureWorkspace`/`startRun` 报 `SandboxUnavailable`，映射为 `TeamError executor_failure`——拒绝执行，不回落到共享或宿主执行路径。`revoke(workspaceId)` 杀死该工作区全部运行并在状态目录留下 `REVOKED` 标记：其后的 `start`/`read`/`publishArtifact` 一律以 `workspace_membership_required` 拒绝，且重启后仍然拒绝。`cancel` 杀死运行；已取消或未完成的运行不能发布产物。

## 运行独立服务

镜像 `team-p0` 的方式：

```bash
node apps/server/scripts/team-isolation.ts ../team-isolation-config.json ../team-isolation-state
```

配置与 `TeamConfig` 相同（`users`/`memberships`），`workspaces` 每项为 `{ "id", "credentials": {ENV}, "networkMode"?: "none"|"bridge" }`。服务监听 `127.0.0.1:3781/team/rpc`。

## 验收证据

`apps/server/src/team/TeamExecutionBoundary.test.ts` 对真实 Docker 执行对抗矩阵（需要 `docker` 守护进程；GitHub `ubuntu-latest` 运行器自带）：

- 租户 A 在自己的沙箱中读自己的 canary、发产物、重连状态；
- 租户 A 的恶意运行 `find /`、`ps`、`env` 均不可见租户 B 的文件、进程和凭据 canary；
- 取消的运行不能发布产物；撤权后新工作、读、发布全部拒绝；
- 无容器运行时路径以 `executor_failure` 失败关闭。

宿主机若无 Docker（如未安装 Docker Desktop），该 `it.live` 测试按环境前置条件失败——这是真实前置要求，不要用替身代替。
