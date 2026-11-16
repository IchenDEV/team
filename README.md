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

日常同步请运行脚本：
`scripts/sync-upstream.sh`

同步规则：

1. 运行前必须保证本地没有未提交的改动。
2. 脚本从 `https://github.com/pingdotgg/t3code.git` 拉取上游主分支并执行合并。
3. 合并过程不执行强制覆盖。
4. 完成本地合并后，请人工审查改动并在分支仓库发起合并请求，严禁直接推送到上游仓库。

可选验证命令：
`gh repo sync IchenDEV/team --source pingdotgg/t3code --branch main`

注意：该命令仅供验证分支状态，严禁使用 `--force`。若出现代码分叉，必须使用上述同步脚本执行合并。

## 开源许可

本项目遵循 MIT 许可证，保留原作者版权声明。详见 [LICENSE](./LICENSE) 文件。
