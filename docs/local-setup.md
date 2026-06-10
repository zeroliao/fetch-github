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

AI 模型在页面 `AI 模型配置` 中统一填写：

```text
类型：chat 或 embedding
Base URL
模型
API key 环境变量名
API Key
向量维度：仅 embedding 需要
```

系统会把 API Key 明文写入本地 `.env.local`，数据库只保存环境变量名、Base URL 和模型名。

不要提交 `.env.local`。

## 本地启动

```powershell
docker compose up -d postgres
pnpm db:init
pnpm dev
```

访问地址：

```text
http://localhost:3020
```

首次访问会跳转到 `/login`。使用 `.env.local` 中的 `ADMIN_USERNAME` 和生成哈希时使用的明文密码登录。

## 验证命令

```powershell
pnpm typecheck
pnpm build
pnpm worker:dev
```

## 页面操作

- `GITHUB_TOKEN` 用来避免 GitHub API 匿名限流。
- `发现配置` 可以用自然语言生成发现条件。系统会先把中文需求解析为关键词、Topics、语言权重、排除词、最低 stars 和活跃时间，再由代码生成合法 GitHub Search 查询。
- 同一条 GitHub Search query 中多个普通关键词通常会缩小召回范围；系统默认把多个关键词拆成多条 query，提高候选召回，再通过规则分、上下文分、LLM 分和反馈分排序。
- `我的 GitHub` 可以点击 `同步 GitHub`，同步 owned/starred repositories；私有仓库默认不参与推荐上下文。
- `发现配置` 可以启用/停用权威扫描源，并调整来源权重；当前已接入扫描的是 GitHub Search、Topics、高 Star 和近期活跃查询。
- AI 配置集中在页面里完成，密钥值只保存在本地 `.env.local`。
- 登录后可以点击右上角锁形按钮修改管理员密码；新密码会更新 `.env.local` 中的 `ADMIN_PASSWORD_HASH`。
- Chat 模型和 Embedding 模型分开配置，但都在同一个 `AI 模型配置` 页面管理。
- 发现配置会显式绑定一个 Chat provider 和一个 Embedding provider；被发现配置使用中的 provider 不能删除或停用。
- 如果删除 AI 配置时报“正在被发现配置使用”，先到 `发现配置` 页面把 Chat/Embedding 绑定切换到其他已启用 provider，再删除。
- `知识库同步` 可以点击 `同步 L4`，系统会生成派生知识内容 hash，并写入 `knowledge_syncs` 状态。
- 知识库目标选择 `local-derived-index` 时只记录 fetchGithub 派生索引状态。
- 知识库目标选择 `ai-knowledge-base` 时会写入 `AI_KNOWLEDGE_BASE_DIR/derived/fetchGithub`；未配置目录会记录为失败，不影响 fetchGithub 源数据。
- `运行观测` 页面可以查看资源调节事件、队列积压、AI 作业和估算成本。
