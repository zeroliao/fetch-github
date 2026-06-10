# 功能闭环审计

更新时间：2026-06-10

## 审计结论

当前项目已经具备可运行的发现工作台闭环：配置、扫描、推荐、反馈、AI 配置、GitHub 上下文同步、知识库派生同步、长任务恢复、漏跑策略、历史任务归档和运行观测均可操作并持久化。生产环境已部署到 `github.zero007.chat`。后续优化主要集中在 FastGPT 等更多外部知识库 adapter、成本价格配置 UI 和更完整的端到端测试。

## 已修复的闭环问题

### AI 配置

- `AI 模型配置` 支持创建、启用、停用、删除、测试。
- Chat 和 Embedding provider 分开配置。
- 发现配置只能绑定已启用且类型正确的 provider。
- 正在被发现配置使用的 provider 不能删除，也不能停用。
- API Key 值只写入 `.env.local`，数据库只保存 `apiKeyEnv`。
- 创建表单成功后会重置，失败会显示错误。

### 发现配置

- 发现配置支持创建和编辑。
- 可编辑项包括启用状态、扫描周期、开始时间、数量限制、偏好、排除规则、资源策略和 AI 绑定。
- 保存后通过 `PATCH /api/profiles/[id]` 持久化。
- AI provider 删除前可以通过发现配置页面解除绑定。

### 扫描与推荐

- `立即扫描` 会基于当前发现配置生成 GitHub Search 查询。
- 发现配置支持权威来源启停和权重：GitHub Search、Topics、高 Star、近期活跃已接入扫描；GitHub Trending、Explore、OSS Insight、GH Archive、OpenSSF、ecosyste.ms 已作为来源配置/质量信号预留。
- 扫描前校验发现配置是否存在、是否启用、AI 绑定是否有效。
- 扫描后刷新任务、队列和推荐列表。
- 已完成或失败的历史扫描任务支持归档，默认任务列表不再显示已归档记录，但数据库保留审计数据。
- GitHub 限流或 token 错误会显示更明确的提示。
- repository 链接和 GitHub 按钮会在新标签打开，并使用 `rel="noopener noreferrer"`。

### 反馈

- 支持 `save`、`hide`、`like`、`dislike`、`track`。
- `save`、`hide`、`track` 会更新推荐状态。
- 隐藏项目可以通过 `显示隐藏项目` 查看，不会进入不可恢复的视觉状态。

### 我的 GitHub

- 支持通过 `GITHUB_TOKEN` 同步 owned/starred repositories。
- 同步结果会写入 `github_accounts` 和 `user_repos`。
- 私有仓库默认不参与推荐上下文，避免默认送入第三方 AI 流程。
- 可以切换 user repo 是否参与推荐上下文。
- 状态通过 `PATCH /api/github-context/repos/[id]` 持久化。
- GitHub 上下文会参与推荐的 `relatedUserRepos` 和 `githubContextFit` 计算。
- 推荐生成时会把关联项目写入 `repo_context_matches`，便于审计每个候选项目和“我的 GitHub”项目之间的关联原因。

### 数据初始化

- 新增 `app_state` bootstrap 标记。
- 只有全新空库才插入演示 seed 数据。
- 用户删除默认 AI 配置后，不会因为再次打开 Dashboard 被重新补回。

### 数据一致性

- `repos.full_name` 冲突更新时不再更新 `repos.id`，避免破坏已存在的外键引用。
- 修复 `repo_snapshots` 外键问题：仓库 upsert 后使用数据库返回的真实 `repos.id` 写入快照。
- 新增 `GET /api/dashboard` 作为一次性刷新快照接口。
- Seed 数据初始化使用数据库 advisory lock 串行化，避免首次并发访问时重复建表或重复初始化。
- `llm_results.input_hash` 已补齐迁移和线上历史数据回填，便于后续复用 LLM 缓存。
- `repo_context_matches` 已从预留表升级为实际写入和读取路径。

### 前端交互

- 修复开发环境 `127.0.0.1` 访问时 HMR 连接被阻断的问题。
- 验证主导航、详情抽屉、发现配置表单、AI 配置页面、GitHub 上下文和知识库页面可以正常切换。
- 新增 `运行观测` 页面，展示资源调节事件、候选队列、AI 作业和估算成本。
- 补充 favicon，消除页面资源 404 噪声。

### 知识库同步

- 页面显示同步状态、默认 L4 范围和候选项目。
- 支持点击 `同步 L4`，生成 L4 Markdown 内容哈希，并写入 `knowledge_syncs`。
- 支持选择 `local-derived-index` 或 `ai-knowledge-base` 目标。
- `local-derived-index` 只记录派生索引状态；`ai-knowledge-base` 会写入 `AI_KNOWLEDGE_BASE_DIR/derived/fetchGithub`，未配置目录时记录失败。
- 根据 `content_hash` 去重，重复内容会记录为 `skipped`。

## 当前已闭环功能

### 真实低内存长任务扫描

- GitHub Search 分页按 checkpoint 写入 `scan_checkpoints`。
- 候选仓库进入 `candidate_queue`，worker 分阶段推进。
- 支持 pause/resume、runtime pause、memory pressure pause。
- worker 启动时会恢复 stale `running` 候选，并自动继续 `retry_later`、`throttled`、`paused_by_memory`、`paused_by_runtime` 任务。
- `ResourceGovernor` 会根据可用内存调整 batch size，并写入 `resource_events`。

### README、Embedding 和 LLM 分析

- L2 候选会抓取 README 并写入 `repo_documents`。
- Embedding 阶段调用独立 embedding provider，并写入 `repo_embeddings`。
- LLM 阶段调用独立 chat provider，结构化结果写入 `llm_results`。
- LLM 结果会参与 recommendation 摘要、原因、风险和匹配偏好。
- GitHub、Embedding 和 Chat API 请求均设置超时，避免第三方服务长时间挂起导致 worker 卡死。

### 偏好学习

- `like/dislike/save/hide/track` 会转换为 `preference_signals`。
- 推荐重算会读取 profile 级偏好信号。
- 反馈后会刷新推荐列表，界面能看到状态和排序变化。

### GitHub 账号同步

- `POST /api/github-context/sync` 会校验 `GITHUB_TOKEN` 并同步账号、owned、starred。
- 页面支持选择同步 owned/starred。
- 同步后会触发推荐上下文重算。

### 知识库派生同步

- `GET /api/knowledge-syncs` 查看同步状态。
- `POST /api/knowledge-syncs/run` 执行 L4 派生同步。
- 高价值发现结果仍以 fetchGithub 为源数据；外部知识库只作为派生索引。
- `ai-knowledge-base` 写入 adapter 是可选依赖，不共享数据库。

### 调度与运行观测

- 调度按发现配置的 `timezone` 计算。
- 漏跑策略支持 `skip`、`run_once`、`resume`，避免服务恢复后瞬间创建大量扫描任务。
- `paused_by_user` 会被视为 active job，避免手动暂停后被调度器重复启动。
- 运行观测页面展示 `resource_events`、队列状态、`llm_jobs` token 用量和估算成本。

## 后续优化项

- 增加 FastGPT 或其他知识库的真实写入 adapter，但保持可选依赖。
- 在 AI 配置页面增加价格配置 UI，目前成本估算读取 provider `config_json.pricing`。
- 为关键 API 和主要页面增加更完整的端到端测试。

## 已验证

- `pnpm typecheck`
- `pnpm test`
- `pnpm db:init`
- `pnpm build`
- worker bootstrap 和 queue stats 输出
- 线上执行 `pnpm db:init` 并重启 `fetchgithub-web.service`、`fetchgithub-worker.service`。
- `https://github.zero007.chat/api/scans` 和 `https://github.zero007.chat/api/dashboard` 可正常返回。
- Playwright 打开 `http://localhost:3020`，验证推荐、发现配置、我的 GitHub、知识库同步页面。
- Playwright 点击 `同步 L4`，确认写入同步记录。
