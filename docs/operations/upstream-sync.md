# 上游同步

`Sync upstream` 工作流每六小时检查一次上游 `pingdotgg/t3code` 的 `main`，也支持手动触发。
检测到新提交时，它在本仓库生成一个集成候选分支和对应的草稿合并请求，由人工审查后走正常门禁合入。
自动化永远不会改动 `main`、永远不会强推已发布分支、永远不会向上游推送或开 PR。

## 运行结果

脚本 `scripts/sync-upstream.sh` 有三种结果，退出码可直接判断：

- `no-update`（退出码 0）：上游没有新提交，不产生候选。
- `clean`（退出码 0）：合并干净。生成候选分支 `sync/upstream-<base>-<upstream>`，提交保留 `main` 与上游两个父提交。
- `blocked`（退出码 2）：合并冲突或 LICENSE 发生变化。候选分支保持 `main` 的树，只额外包含一份 `UPSTREAM_SYNC_BLOCKED.md` 冲突说明。它不是已集成内容，必须由人工解决。
- 其他错误（退出码 1）：脏检出、不可复用的候选分支等，不产生候选。

本地手动运行时脚本只创建本地候选引用，当前检出与 `main` 均不变。要求 Git ≥ 2.38（`git merge-tree --write-tree`）。夹具可用 `SYNC_UPSTREAM_URL` 覆盖上游地址。

## 候选分支与合并请求去重

分支名由基线和上游两个提交共同决定，同一对输入永远得到同一分支，重复运行不会重复创建。
已存在的同名分支若内容或父提交不同（例如被人工修改过），脚本直接失败，不覆盖。

合并请求由机器人账号创建，正文带 `<!-- team-upstream-candidate -->` 标记。
同一分支已有候选时只更新正文；该候选不是机器人创建或缺少标记时发布失败。
已关闭或已合并的候选不会被重开。新候选发布后，只关闭机器人自己创建的、带标记的旧候选草稿；
已由人工转为正式审查的候选不在关闭范围，其他作者的 PR 一律不动。

## 工作流任务

- `fixtures`：在 `ubuntu-latest` 上运行 `scripts/sync-upstream.test.py`，用真实临时 Git 仓库验证上述全部场景。拉取请求改动脚本或工作流时也会运行，但只做只读验证。
- `sync`：仅在 `IchenDEV/team` 的 `main` 上运行。生成候选、推送分支、创建或更新草稿合并请求。`blocked` 时该任务失败，提示查看草稿。
- `candidate-check`：仅对 `clean` 候选运行。在只读权限下校验候选的父提交与远端 `main` 一致，然后执行 `vp run check:changed` 受影响检查。

## 前置条件与限制

- 仓库设置的 Actions 权限必须允许工作流创建合并请求（Settings → Actions → General → Workflow permissions 勾选 “Allow GitHub Actions to create and approve pull requests”）。未开启时发布步骤会明确失败，不会产生静默成功。
- 工作流文件必须先合入 `main` 才会按计划运行；`GITHUB_TOKEN` 创建的 PR 其检查可能需要维护者批准后才运行。
- 候选合入仍须通过原生 CI（`ci.yml` 的 `Check`）与正常审查门禁，`candidate-check` 不替代它们。
- 权限边界：不使用 PAT、GitHub App 凭据、付费服务、自托管或 Blacksmith 运行器；不强推 `main`；不做自动合并与自动部署。
