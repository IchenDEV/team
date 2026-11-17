# #Team

#Team 是基于 T3 Code 的公开分支版本。

## 概述与约定

- 本仓库是 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 的公开分支（仓库标识为 team）。
- 本项目遵循 MIT 开源许可证，完整保留上游 LICENSE 与版权声明。
- 本阶段仅完成仓库初始化，当前不发布也不部署独立安装包。
- 官方安装渠道仍安装原版 T3 Code，不安装 #Team。
- 为保证环境兼容，`t3` 命令行、`@t3tools` 工作区包名、环境变量、应用标识和数据目录均保持原样。

## 本地开发与构建

源码构建请参考[开发手册](./docs/operations/development.md#first-checkout)。

- 仓库地址：`https://github.com/IchenDEV/team.git`
- 运行环境：Node 26.13.1，pnpm 12.14.0
- 依赖安装：`vp install`
- 启动开发：`vp run dev`

## 同步上游代码

上游同步由 `Sync upstream` 工作流自动完成：每六小时检测上游 `main` 的新提交，生成集成候选分支和草稿合并请求，由人工审查后合入。自动化不会改动 `main`，也不会向上游推送。

手动同步仍可运行 `scripts/sync-upstream.sh`；它只在本地生成候选分支，不改动当前检出。操作细节、退出码与前置条件见[上游同步](./docs/operations/upstream-sync.md)。

## 开源许可

本项目遵循 MIT 许可证，保留原作者版权声明。详见 [LICENSE](./LICENSE) 文件。
