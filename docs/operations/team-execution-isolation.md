# Team 执行环境隔离（一期）

`team.start`/`team.read`/`team.stream` 的执行后端是 `TeamExecutionBoundary`：控制平面先做 Bearer 会话 + 成员/角色鉴权（复用现有 `authorize`，无第二认证系统），再把命令交给该工作区专属的容器沙箱执行。三项绑定：

- **运行**：`team.<workspace>.<user>.<commandId>` → 同一工作区的专属容器（`--name t3ex-<runId>` 原样使用、映射单射，标签 `t3.team.workspace`/`t3.team.run`/命令文本摘要）。相同命令重放返回同一运行；命令体不同的同 ID 提交返回 `command_conflict`。
- **文件系统根**：`<sandboxStateDir>/workspaces/<id>/root`，以读写方式挂载为容器内唯一的 `/workspace`。**项目目录绝不作为沙箱**——根目录由边界独占管理，凭据文件位于挂载树之外。
- **受限环境凭据域**：`<sandboxStateDir>/workspaces/<id>/credentials.env`（0600，来自配置的 `workspaces[].credentials`），仅经 `--env-file` 注入该工作区的运行；宿主环境不会泄漏进沙箱。

容器加固：`--network none`（默认，`workspaces[].networkMode` 可配 `bridge`）、`--read-only` 根文件系统 + `--tmpfs /tmp`、`--cap-drop ALL`、`--security-opt no-new-privileges`、`--pids-limit 64`、`--memory 256m`。

## 失败关闭

`TeamConfig.sandboxStateDir` 未配置或 `docker` 守护进程不可用时，执行路径返回 `executor_failure`——拒绝执行，不回落到宿主执行。`team.deleteWorkspace` 先调用 `boundary.dropWorkspace` 再删除成员面：先落 `REVOKED` 标记（写失败报错、不吞），再杀光该工作区运行——其后的 `start`/`read`/`publishArtifact` 一律拒绝（标记兜底竞态）。取消的运行不能发布产物；产物名限 `[A-Za-z0-9._-]` 且禁止前导点，杜绝目录穿越。

## 配置

`TeamConfig`（`team-p0.ts` 的 CONFIG.json）每工作区新增两个可选字段：`credentials`（注入沙箱的键值 env）与 `networkMode`；顶层新增可选 `sandboxStateDir`。旧配置不含这些字段时边界失败关闭。

## 验收证据

`apps/server/src/team/TeamExecutionBoundary.test.ts` 经真实 `team.login`/`team.start`/`team.read`/`team.stream`/`team.deleteWorkspace` RPC 与真实会话令牌跑对抗矩阵（需要 `docker` 守护进程；GitHub `ubuntu-latest` 运行器自带）：

- 租户 A 在自己的沙箱中读自己的 canary、发布产物、`stream` 收到终态；
- 租户 A 的恶意运行 `find /`、`ps`、`env`/`/proc/1/environ` 均不可见租户 B 的文件、进程和凭据 canary；
- 匿名/跨租户/Viewer 分别 `authentication_required`/`workspace_membership_required`/`viewer_execution_forbidden`；跨租户按真实 runId `read` 亦拒绝；
- 取消的运行不能发布产物；`deleteWorkspace` 后新工作、读、发布全部拒绝，存活容器被清除，租户 A 不受影响；
- `sandboxStateDir` 缺省或容器运行时缺席时 `team.start` 失败关闭为 `executor_failure`。

宿主机若无 Docker，该 `it.live` 测试按环境前置条件失败——这是真实前置要求，不要用替身代替。
