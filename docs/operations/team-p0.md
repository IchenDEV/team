# 团队网关与成员权限运维指南

本指南说明如何在独立环境中启动团队服务并管理受邀成员权限。系统在服务重启后仍会保留成员数据与工作区归属。

## 1. 运行环境与依赖安装

运行环境锁定 Node 26.13.1 与 pnpm 12.14.0。使用锁定文件在独立目录安装依赖：

```bash
pnpm install --frozen-lockfile
```

## 2. 启动合成执行器与颁发令牌

在独立终端启动专用的底层执行器（端口 3792）：

```bash
node apps/server/src/bin.ts --base-dir ISOLATED_EXECUTOR_HOME --host 127.0.0.1 --port 3792 --dev-url http://127.0.0.1:3792 --no-browser
```

在相同数据目录下生成合成会话令牌：

```bash
node apps/server/src/bin.ts auth session issue --base-dir ISOLATED_EXECUTOR_HOME --subject team-native-fixture --token-only > NEW_SYNTHETIC_TOKEN_FILE
```

令牌仅保存在临时文件中，禁止提交到代码仓库。

## 3. 网关配置文件

网关配置仅声明工作区映射与执行器凭据，不再包含静态用户、用户令牌或成员关系：

```json
{
  "workspaces": [
    {
      "id": "alpha",
      "projectId": "PROJECT_ID_1",
      "modelSelection": { "instanceId": "devReplay", "model": "todo-list" },
      "rpcUrl": "ws://127.0.0.1:3792/ws?orchestrationProtocol=2",
      "bearer": "TOKEN_FROM_NEW_SYNTHETIC_TOKEN_FILE"
    }
  ]
}
```

执行器中的项目必须已存在，且与 `projectId` 对应；真实验证脚本会为合成配置创建项目。

## 4. 网关初始化与服务启动

首次运行需引导首位拥有者（用户标识为 `owner`）并关联首个工作区：

```bash
node apps/server/scripts/team-p0.ts CONFIG.json ISOLATED_GATEWAY_HOME bootstrap NEW_INVITATION.json
```

若服务已初始化，该命令会报错退出。随后在同一数据目录下启动网关服务（默认本地回环端口 3781）：

```bash
node apps/server/scripts/team-p0.ts CONFIG.json ISOLATED_GATEWAY_HOME serve
```

## 5. 客户端调用与接口交互

客户端通过 HTTP NDJSON 访问 `http://127.0.0.1:3781/team/rpc`。
协议栈使用 `TeamRpcGroup` + `RpcClient.layerProtocolHttp` + `FetchHttpClient.layer` + `RpcSerialization.layerNdjson`。
网关仅接受 Bearer 凭据，不接受 DPoP 与 MCP 凭据，不支持公网注册与前端界面。

- 会话：调用 `team.login({ credential })` 获取 `AuthAccessTokenResult` 中的 `access_token`，后续请求携带 `authorization: Bearer <access_token>`；`team.logout()` 吊销会话。
- 成员：仅拥有者可调用 `team.invite({ workspaceId, userId, name, role })` 为新身份生成一次性邀请码；已有身份返回 `user_already_invited`，避免签发他人的登录凭据。通过 `team.setMember` 将已有用户加入工作区或调整角色，通过 `team.removeMember` 移除成员。
- 工作区：通过 `team.workspaces`、`team.workspace`、`team.members` 查询；`team.createWorkspace` 需要拥有者权限且服务端已配置绑定，每个工作区对应独立项目；支持 `team.renameWorkspace` 与 `team.deleteWorkspace`。
- 执行：调用 `team.start`、`team.read` 与 `team.stream`。只读成员禁止执行；网络重连或网关重启后保留已完成任务的稳定运行标识与输出引用；权限撤销或登出时，挂起的流会以 `authentication_required` 或 `workspace_membership_required` 异常立即终止。

## 6. 本地验证

运行控制面与持久化相关的单元测试（共 20 项测试）：

```bash
vp test run apps/server/src/team/TeamControlPlane.test.ts apps/server/src/team/TeamRuntime.test.ts apps/server/src/persistence/TeamMemberships.test.ts apps/server/src/persistence/Migrations.test.ts
```

运行代码与类型检查：

```bash
vp run check:changed
```

运行真实网络证明脚本（配置需包含 alpha、beta、gamma 三个独立项目，指令标识符小于 50 字符，网关目录必须为空）：

```bash
node apps/server/scripts/team-p0-proof.ts SYNTHETIC_CONFIG.json NEW_GATEWAY_HOME UNIQUE_COMMAND_ID
```

该脚本会在配置文件同级目录下创建项目 Git 仓库，启动并重启网关，校验会话持久化与实时流吊销。验证完成后请手动终止所启动的进程。

## 7. 边界与限制

操作系统级沙箱未经验证。测试仅使用受信任内部合成数据，重放执行器仅模拟模型响应，HTTP、RPC、SQLite 与鉴权均为真实运行。已删除的工作区与项目标识仍保持预留；新建工作区请使用服务端配置的新绑定。未经验收前请勿用于浏览器端、移动端或生产环境。
