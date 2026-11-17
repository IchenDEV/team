# 团队身份与工作区运维指南

团队网关不再单独运行。成员身份、工作区、成员关系与共享产物都由**同一个环境服务端**提供，使用同一套 SQLite 与同一个会话。因此一个成员只需登录一次：`/team/rpc` 与 `/api/team/workspaces/*` 接受同一个 Bearer 令牌。

运行环境仍锁定 Node 26.13.1 与 pnpm 12.14.0，使用锁定文件安装依赖：

```bash
pnpm install --frozen-lockfile
```

## 1. 工作区配置

环境服务端通过 `TEAM_CONFIG_FILE` 读取本环境承载的工作区。文件内容与 `TeamConfig` 一致：

```json
{
  "workspaces": [
    {
      "id": "alpha",
      "projectId": "PROJECT_ID_1",
      "modelSelection": { "instanceId": "devReplay", "model": "todo-list" },
      "credentials": { "T3_TENANT_CREDENTIAL": "value" },
      "networkMode": "none"
    }
  ],
  "sandboxStateDir": "/absolute/path/for/workspace/sandboxes"
}
```

- `projectId` 必须是本环境中已存在的项目。
- `credentials` 与 `networkMode` 是执行沙箱的字段，见 `team-execution-isolation.md`。
- `sandboxStateDir` 缺省为 `<environment home>/team-sandbox`。
- 未设置 `TEAM_CONFIG_FILE` 时本环境不承载任何工作区：成员关系仍可读取，工作区写入与执行返回 `workspace_not_configured`。
- 设置了但读不到或解析失败时，服务端启动失败并给出原因，不静默降级。

## 2. 首位拥有者初始化

服务端**停止**时执行一次性初始化（它持有与环境服务端相同的所有权锁）：

```bash
node apps/server/scripts/team-bootstrap.ts CONFIG.json ENVIRONMENT_HOME OWNER_INVITATION.json
```

它写入首位拥有者 `owner` 与配置中的第一个工作区，并把一次性邀请凭据写入 `OWNER_INVITATION.json`（权限 600）。凭据只用于登录一次，不要提交到仓库。

已有数据时命令报错退出；后续成员只能由拥有者通过 RPC 邀请。

## 3. 启动与登录

用 `TEAM_CONFIG_FILE` 指向配置文件启动环境服务端（正常启动方式不变）。客户端调用：

- `POST /team/rpc`，NDJSON，`team.login({ credential })` 换取 `access_token`；后续请求带 `authorization: Bearer <access_token>`。
- 同一个令牌直接访问 `GET/POST /api/team/workspaces/<workspaceId>/artifacts...`。

浏览器与桌面端都不再需要团队网关地址：成员连接表单里的地址就是当前环境地址。

## 4. 角色与令牌范围

团队令牌只带 `orchestration:read`，任何角色都是如此。原因是它同时是这个环境的会话：一旦带上 `orchestration:operate`，成员就能绕过工作区沙箱，直接通过环境的 WebSocket 启动宿主机上的执行。

角色由成员表在每次请求时判定：

- Viewer：只能读成员、产物与工作区；写产物、改成员、执行都返回拒绝。
- Owner / Editor：可以写产物与执行，执行仍在工作区容器沙箱内。

因此提升角色不需要重新签发凭据；降级或移除立即生效（`team.setMember` 与 `team.removeMember` 下一次请求即按新角色判定）。被移除的成员若已不属于本环境的任何工作区，其环境会话会被吊销，不再能读取本环境的项目与线程；仍属于其它工作区时保留会话。

环境会话本身仍是只读信任域：它能读本环境的项目与线程，这是“一个环境一个信任域”的边界，不随团队角色变化。

## 5. 边界

- 一个环境即一个信任域：本环境的项目、线程对持有本环境会话的成员可见。需要按工作区隔离时，为每个工作区使用独立环境（见执行隔离文档），不要在一个环境里承载互不信任的工作区。
- 工作区拥有者不能为已存在的全局身份重新签发凭据；过期邀请由环境运营者按既有认证方式恢复，见 `team-invite-expiry-boundary` 说明。
- 操作系统级沙箱仍以执行隔离文档为准。

## 6. 本地验证

单元与接缝测试：

```bash
vp test run apps/server/src/team/TeamControlPlane.test.ts apps/server/src/team/TeamIdentitySeam.test.ts apps/server/src/team/TeamArtifactsHttp.test.ts apps/server/src/persistence/TeamMemberships.test.ts
```

真实进程证明（新建空环境目录，启动真实 HTTP 服务，成员登录后同时使用成员面与产物面，并重启复验）：

```bash
node apps/server/scripts/team-identity-proof.ts SYNTHETIC_CONFIG.json NEW_ENVIRONMENT_HOME UNIQUE_COMMAND_ID
```

该脚本输出一行 JSON，包含登录、成员面、同令牌产物面、匿名读取 401、Viewer 写入 403、跨工作区拒绝、凭据重放拒绝与重启持久化的结果。验证完成后手工结束所启动的进程。
