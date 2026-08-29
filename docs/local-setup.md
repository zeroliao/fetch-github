# 本地配置说明

## 你需要提供的信息

你需要先生成管理员密码哈希：

```powershell
pnpm auth:hash "your-admin-password"
```

然后在 `.env.local` 里填入管理员账号、密码哈希和 GitHub token：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=
GITHUB_TOKEN=
AI_KNOWLEDGE_BASE_DIR=../ai-knowledge-base
```

Provider 出口代理不再通过 `.env.local` 配置。请确保服务器上的 Sing-box 服务已运行，并在 Provider 编辑抽屉中刷新节点、填写 Base URL 后执行连通性检测；检测通过的节点按耗时升序展示，可多选并按顺序尝试，全部失败时直连兜底。

AI 模型在页面 `AI 模型配置` 中统一填写：

```text
类型：chat 或 embedding
Base URL
模型名称（同时作为 API Key 名称）
API Key
优先级：数值越小越先使用
推理程度：仅 chat，可选 default/minimal/low/medium/high/xhigh
向量维度：仅 embedding 需要
```

系统直接使用模型名称规范化后的值作为 API Key 环境变量名，并把 API Key 明文写入本地 `.env.local`；数据库只保存环境变量名、Base URL 和模型名。模型名称必须唯一，名称变化时必须同时重新填写 API Key。

不要提交 `.env.local`。

## 本地启动

```powershell
docker compose up -d postgres
pnpm db:init
pnpm dev
```

需要清空现有业务数据和应用配置，并重建默认「变现机会雷达」配置时运行：

```powershell
pnpm db:reset-opportunity
```

该命令会清空扫描、推荐、GitHub 关联、AI Provider 组/模型记录、会话和应用状态，然后创建默认禁用的 Chat / Embedding 模型占位配置；不会删除 `.env.local` 中的 API Key 或管理员密码哈希。

访问地址：

```text
http://localhost:3020
```

首次访问会跳转到 `/login`。使用 `.env.local` 中的 `ADMIN_USERNAME` 和生成哈希时使用的明文密码登录。

## 验证命令

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm worker:dev
```

## Cloudflare Access SSH

生产服务器使用 SSH alias `sub2api-cf`。从 Windows PowerShell 连接时，可以使用项目脚本：

```powershell
.\scripts\invoke-cloudflare-ssh.ps1 -RemoteCommand "systemctl is-active fetchgithub-web.service"
```

脚本先执行一次 SSH。如果错误表明 Cloudflare Access 登录可能过期，会打开浏览器要求重新授权，并在授权成功后自动重试一次。脚本不会输出 JWT，也不会修改全局 SSH 配置；第二次仍失败时以非零 exit code 退出。

## 页面操作

- `GITHUB_TOKEN` 用来避免 GitHub API 匿名限流。
- `发现配置` 可以用自然语言生成发现条件。系统会先把中文需求解析为关键词、Topics、语言权重、排除词、最低 stars 和活跃时间，再由代码生成合法 GitHub Search 查询。
- 同一条 GitHub Search query 中多个普通关键词通常会缩小召回范围；系统默认把多个关键词拆成多条 query，提高候选召回，再通过规则分、上下文分、LLM 分和反馈分排序。
- `我的 GitHub` 可以点击 `同步 GitHub`，同步 owned/starred repositories；私有仓库默认不参与推荐上下文。
- `发现配置` 保留核心偏好、机会 Brief、最低机会分、最低可用内存和漏跑策略；扫描不再受候选数量、运行分钟或各阶段 Top K 截断。
- worker 按实时可用内存动态调整批量，并在内存恢复后自动继续；启用的发现配置会按内部固定周期持续产生扫描任务。
- AI 配置集中在页面里完成，密钥值只保存在本地 `.env.local`。
- 每个模型使用由自身名称确定的独立 API Key 环境变量；模型轮换时按当前 Provider 读取对应 Key，不会沿用上一个模型的 Key。
- 登录后可以点击右上角锁形按钮修改管理员密码；新密码会更新 `.env.local` 中的 `ADMIN_PASSWORD_HASH`。
- Chat 模型和 Embedding 模型分开配置，但都在同一个 `AI 模型配置` 页面管理；同类型模型按优先级数值从小到大自动选择。
- 删除 AI 配置使用软删除，历史 Embedding/LLM 数据仍保留，发现配置无需解绑具体 Provider。
- `blocked_auth`、`blocked_permission` 或 `invalid_config` 表示需要人工修复。更新 API Key、权限、Base URL、模型名或参数后，点击“检测并恢复”；只有真实调用成功才会恢复为 `available`。
- `cooldown` 表示限流、网络、超时或服务端故障的临时冷却；到期后系统会在下一次选择前执行一次真实检测，检测成功才恢复为 `available`。
- 连续 3 次模型 JSON 解析或 Schema 校验失败会在当前扫描周期内轮换下一个同类型模型；全部耗尽时扫描进入 `exception`，恢复模型后再到“系统运行”中的“扫描周期与恢复”模块手动恢复。
- `知识库同步` 可以点击 `同步 L4`，系统会生成派生知识内容 hash，并写入 `knowledge_syncs` 状态。
- 知识库目标选择 `local-derived-index` 时只记录 fetchGithub 派生索引状态。
- 知识库目标选择 `ai-knowledge-base` 时会写入 `AI_KNOWLEDGE_BASE_DIR/derived/fetchGithub`；未配置目录会记录为失败，不影响 fetchGithub 源数据。
- `运行观测` 页面可以查看资源调节事件、队列积压、AI 作业和估算成本。
