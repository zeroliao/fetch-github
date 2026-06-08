# 本地配置说明

## 你需要提供的信息

你需要在 `.env.local` 里填入 GitHub token：

```env
GITHUB_TOKEN=
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

## 验证命令

```powershell
pnpm typecheck
pnpm build
pnpm worker:dev
```

## 页面操作

- `GITHUB_TOKEN` 用来避免 GitHub API 匿名限流。
- `我的 GitHub` 可以点击 `同步 GitHub`，同步 owned/starred repositories；私有仓库默认不参与推荐上下文。
- `发现配置` 可以启用/停用权威扫描源，并调整来源权重；当前已接入扫描的是 GitHub Search、Topics、高 Star 和近期活跃查询。
- AI 配置集中在页面里完成，密钥值只保存在本地 `.env.local`。
- Chat 模型和 Embedding 模型分开配置，但都在同一个 `AI 模型配置` 页面管理。
- 发现配置会显式绑定一个 Chat provider 和一个 Embedding provider；被发现配置使用中的 provider 不能删除或停用。
- 如果删除 AI 配置时报“正在被发现配置使用”，先到 `发现配置` 页面把 Chat/Embedding 绑定切换到其他已启用 provider，再删除。
- `知识库同步` 可以点击 `同步 L4`，系统会生成派生知识内容 hash，并写入 `knowledge_syncs` 状态。
- 当前知识库同步目标是本地派生状态记录 `local-derived-index`，不会强制写入同级 `../ai-knowledge-base`。
