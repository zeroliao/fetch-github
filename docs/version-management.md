# 版本发布流程

本文档是 `fetchGithub` 的版本、分支、部署和回滚流程说明。它吸收 `sub2api-wrap` 的版本经验，但按当前项目的单仓库、Next.js、PostgreSQL、systemd 部署方式做了简化。

## 目标

- 每次生产变更都有版本号、版本记录、验证结果和部署结果。
- `main` 只保存已经部署成功或准备立即部署的稳定代码。
- 服务器只部署 GitHub 上已推送的 commit，不部署本地未提交改动。
- 数据库迁移、服务重启和线上验证必须写入版本记录。
- 失败版本保留记录和排查线索，不复用版本号。

## 分支与版本模型

当前项目使用单仓库版本号，格式为三位递增数字：

```text
dev/<version>
release/<version>
v<version>
docs/releases/<version>.md
```

- `main`：稳定主分支，生产部署从这里或 `release/<version>` 快进而来。
- `dev/<version>`：较大版本或多步改动的开发分支。
- `release/<version>`：部署候选分支，只接收从 `dev/<version>` 同步过来的候选内容。
- `v<version>`：生产部署成功后创建的 tag。
- `docs/releases/<version>.md`：版本记录，是版本状态的权威记录。

版本状态只使用：

```text
开发中
已提测
成功
失败
取消
```

版本号从本仓库本地和远程的 `dev/*`、`release/*`、`v*` tag，以及 `docs/releases/*.md` 共同计算。下一版本号必须是最大已占用版本号 + 1；历史缺口不可复用。

## 适用范围

必须走版本流程：

- 会部署到 `github.zero007.chat` 的代码改动。
- 数据库 schema、迁移、数据回填、定时任务、worker、AI 调用、鉴权、部署配置变更。
- 大范围 UI 或用户流程变更。
- 需要回滚点的修复。

可以直接走普通 commit：

- 不部署的临时实验。
- 小型文档整理。
- 本地工具或测试辅助改动。

即使是普通 commit，一旦准备部署生产，也必须补版本记录。

## 标准流程

### 1. 创建版本

1. 计算当前最大已占用版本号。
2. 创建 `docs/releases/<version>.md`。
3. 填写版本类型、目标、初始 commit、风险和验收标准。
4. 对较大改动创建 `dev/<version>`；小修可直接在当前分支完成，但部署前仍要创建版本记录。

### 2. 开发

1. 代码改动进入 `dev/<version>` 或当前任务分支。
2. 同一批逻辑改动只沿一条提交链流动，不在多个分支重复手工提交同一补丁。
3. 不直接在 `release/<version>` 上做日常开发。
4. 涉及 secrets 的配置只记录环境变量名，不把真实值写入文档、日志或提交。

### 3. 本地验证

根据改动范围运行验证：

```powershell
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

如果涉及数据库：

```powershell
pnpm db:init
```

如果涉及 worker 或扫描：

```powershell
pnpm worker:dev
```

验证结果写入版本记录。

### 4. 提测

1. 将 `dev/<version>` 同步到 `release/<version>`，优先 fast-forward。
2. 如果不能 fast-forward，先检查分叉原因，不为了推进发布而重做同一补丁。
3. `release/<version>` 验证通过后，状态改为 `已提测`。
4. 小型单分支发布可以跳过长期保留的 `release/<version>`，但版本记录必须说明部署 commit。

### 5. 部署

服务器部署必须使用已推送 commit。

推荐顺序：

```powershell
git status --short
git push origin <branch>
ssh sub2api "cd /home/ubuntu/projects/fetch-github && git fetch origin && git checkout <branch-or-main> && git pull --ff-only"
ssh sub2api "cd /home/ubuntu/projects/fetch-github && corepack pnpm install --frozen-lockfile"
ssh sub2api "cd /home/ubuntu/projects/fetch-github && corepack pnpm db:init"
ssh sub2api "cd /home/ubuntu/projects/fetch-github && corepack pnpm build"
ssh sub2api "sudo systemctl restart fetchgithub-web.service fetchgithub-worker.service"
```

部署前如果服务正在执行长任务，优先：

1. 查看 `fetchgithub-worker.service` 日志。
2. 确认任务是否可暂停或已完成。
3. 停止 worker，再停止 web。
4. 完成部署后先启动 web，再启动 worker。

### 6. 线上验证

至少验证：

```powershell
ssh sub2api "systemctl is-active fetchgithub-web.service"
ssh sub2api "systemctl is-active fetchgithub-worker.service"
ssh sub2api "journalctl -u fetchgithub-web.service -n 40 --no-pager"
ssh sub2api "journalctl -u fetchgithub-worker.service -n 40 --no-pager"
```

外部 URL：

```text
https://github.zero007.chat/
https://github.zero007.chat/operations
https://github.zero007.chat/api/dashboard
```

未登录时：

- 页面应跳转到 `/login`。
- API 应返回 `401` 和中文错误。

需要验证鉴权数据时，只能创建短期临时 session，并在验证后删除；不要打印管理员密码、API key 或 token。

### 7. 成功归档

部署成功后：

1. 版本状态改为 `成功`。
2. 记录部署 commit、服务器路径、服务状态、线上验证结果。
3. 将 `release/<version>` 合入 `main`，优先 fast-forward。
4. 创建 `v<version>` tag。
5. 推送 `main` 和 tag。
6. 清理或归档不再使用的 `dev/<version>`。

### 8. 失败或取消

部署失败：

- 状态改为 `失败`。
- 记录失败命令、错误摘要、影响范围和下一步。
- 如服务不可用，回滚到上一个成功 tag。
- 不合入 `main`，不打成功 tag。

取消版本：

- 状态改为 `取消`。
- 记录取消原因。
- 版本号不复用。

## 数据库与回滚规则

`pnpm db:init` 当前会应用 `db/schema.sql` 中的幂等 schema。涉及破坏性变更时，版本记录必须写明：

- 受影响表和字段。
- 是否有数据删除、类型收窄、不可逆回填。
- 备份方式。
- 回滚方式。

部署前建议备份：

```powershell
ssh sub2api "pg_dump <database> > /home/ubuntu/fetchgithub-backup-$(date +%Y%m%dT%H%M%S).sql"
```

实际命令应按服务器 `DATABASE_URL` 解析后执行，不能在文档或日志中暴露密码。

回滚应用代码：

```powershell
ssh sub2api "cd /home/ubuntu/projects/fetch-github && git checkout v<last-success-version> && corepack pnpm install --frozen-lockfile && corepack pnpm build && sudo systemctl restart fetchgithub-web.service fetchgithub-worker.service"
```

数据库回滚不自动执行；如果需要恢复 dump，必须先停止 web/worker，并明确用户确认。

## 节点完成信号

| 节点 | 完成信号 |
| --- | --- |
| 创建版本 | `docs/releases/<version>.md` 已创建，状态为 `开发中` |
| 开发完成 | 工作区干净，commit 已完成 |
| 本地验证 | 版本记录写明 typecheck/test/build/diff-check 结果 |
| 提测 | `release/<version>` 或部署 commit 已推送，状态为 `已提测` |
| 部署 | 服务器 commit、`db:init`、`build`、服务重启结果已记录 |
| 线上验证 | 登录页、API 鉴权、服务日志和核心路径验证通过 |
| 成功归档 | 状态为 `成功`，`main` 和 `v<version>` 已推送 |
| 失败/取消 | 状态为 `失败` 或 `取消`，原因已记录 |

## 当前项目建议节奏

`fetchGithub` 还处于快速演进期，建议采用轻量版本：

- 小型修复：`main` 上完成、验证、提交、部署，然后补一个 release 记录和 tag。
- 中型功能：创建 `dev/<version>`，完成后 fast-forward 到 `release/<version>`，部署成功再合入 `main`。
- 高风险变更：必须创建 `release/<version>`，部署前做数据库备份，并写明回滚目标。

## 版本记录模板

新版本复制 `docs/releases/TEMPLATE.md` 到：

```text
docs/releases/<version>.md
```

