# Team P0 本地权限验证

### 环境准备与服务启动（终端 1）

运行环境锁定 Node 26.13.1 与 pnpm 12.14.0。请在独立终端中使用一次性目录，避免污染日常配置：

```bash
git clone https://github.com/IchenDEV/team.git
cd team
git switch feat/team-p0-boundary
pnpm install --frozen-lockfile
pnpm exec vp test run apps/server/src/team/TeamControlPlane.test.ts
pnpm exec vp run check:changed
pnpm --filter t3 build:bundle
node apps/server/src/bin.ts --base-dir ../team-p0-state --host 127.0.0.1 --port 3782 --dev-url http://127.0.0.1:3782 --no-browser --auto-bootstrap-project-from-cwd
```

### 令牌获取与配置文件（终端 2）

在第二个独立终端中生成合成会话令牌并查询项目标识：

```bash
node apps/server/src/bin.ts auth session issue --base-dir ../team-p0-state --token-only > ../team-p0-token.txt
sqlite3 ../team-p0-state/userdata/statev2.sqlite 'select project_id,title from projection_projects;'
```

在代码仓库外创建 `../team-p0-config.json`，禁止使用真实凭据。紧凑配置示例：

```json
{
  "users": [
    { "id": "alice", "token": "TOKEN_ALICE_RANDOM_HEX_AT_LEAST_32_CHARS" },
    { "id": "bob", "token": "TOKEN_BOB_RANDOM_HEX_AT_LEAST_32_CHARS" }
  ],
  "memberships": [
    { "userId": "alice", "workspaceId": "alpha", "role": "Editor" },
    { "userId": "bob", "workspaceId": "beta", "role": "Viewer" }
  ],
  "workspaces": [
    {
      "id": "alpha",
      "projectId": "<PROJECT_ID_FROM_SQLITE>",
      "modelSelection": { "instanceId": "devReplay", "model": "todo-list" },
      "rpcUrl": "ws://127.0.0.1:3782/ws?orchestrationProtocol=2",
      "bearer": "<PASTE_TOKEN_FROM_TEAM_P0_TOKEN_TXT>"
    },
    {
      "id": "beta",
      "projectId": "<PROJECT_ID_FROM_SQLITE>",
      "modelSelection": { "instanceId": "devReplay", "model": "todo-list" },
      "rpcUrl": "ws://127.0.0.1:3782/ws?orchestrationProtocol=2",
      "bearer": "<PASTE_TOKEN_FROM_TEAM_P0_TOKEN_TXT>"
    }
  ]
}
```

### 启动服务与验证脚本

在终端 2 启动团队服务，终端 3 运行验证脚本：

```bash
node apps/server/scripts/team-p0.ts ../team-p0-config.json
node apps/server/scripts/team-p0-proof.ts ../team-p0-config.json p0-example
```

- 服务监听地址：`127.0.0.1:3781/team/rpc`。
- 指令命名规范：指令标识符需符合正则 `/^[A-Za-z0-9_-]{1,64}$/`。
- 结束运行：在各终端中通过 `Ctrl-C` 终止相应进程。
- 隔离说明：双工作区共享单执行器仅作为权限验证证据，不构成系统级环境隔离。
