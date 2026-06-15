import type { Recommendation, RepoSummary } from "./types";

const preferenceLabels: Record<string, string> = {
  ai: "AI",
  agent: "Agent",
  agents: "Agents",
  automation: "自动化",
  "developer-tools": "开发者工具",
  developer: "开发者",
  embedding: "向量检索",
  llm: "LLM",
  rag: "RAG",
  retrieval: "检索增强",
  workflow: "工作流",
  workflows: "工作流"
};

export function containsChineseText(value: string) {
  return /[\u3400-\u9fff]/.test(value);
}

export function getRecommendationSummaryZh(recommendation: Recommendation) {
  return ensureChineseSummary(
    recommendation.summaryZh ?? recommendation.summary,
    recommendation.repo,
    recommendation.matchedPreferences
  );
}

export function ensureChineseSummary(
  value: string | undefined,
  repo: RepoSummary,
  matchedPreferences: string[] = []
) {
  const summary = value?.trim() ?? "";
  if (summary && containsChineseText(summary) && !looksLikeTemplateSummary(summary)) {
    return summary;
  }

  return buildChineseRepoSummary(repo, matchedPreferences, summary);
}

export function buildChineseRepoSummary(
  repo: RepoSummary,
  matchedPreferences: string[] = [],
  sourceText = ""
) {
  const text = normalizeFunctionalSourceText(sourceText || repo.description || repo.fullName);
  const purpose = inferFunctionalPurpose(text, repo);
  const domain = inferFunctionalDomain(text, repo);
  const capabilities = inferFunctionalCapabilities(text, repo);
  const audience = inferFunctionalAudience(text, repo, matchedPreferences);

  const parts = [purpose || domain, ...capabilities.slice(0, 3)].filter(Boolean);
  if (audience) {
    parts.push(formatAudience(audience));
  }

  if (parts.length === 0) {
    const fallback = repo.description?.trim();
    if (fallback) {
      if (containsChineseText(fallback)) {
        return `功能：${fallback}`;
      }
      return "功能：GitHub 描述未提供足够明确的用途信息，需要查看 README 确认具体能力。";
    }

    const language = repo.primaryLanguage && repo.primaryLanguage !== "Unknown"
      ? `${repo.primaryLanguage} 项目`
      : "GitHub 项目";
    return `功能：${language}。`;
  }

  return `功能：${parts.join("；")}。`;
}

export function normalizeChineseLabels(items: string[]) {
  return items.map(localizeDisplayText).filter(Boolean);
}

export function localizeDisplayText(value: string) {
  const text = value.trim();
  if (!text) {
    return "";
  }
  if (containsChineseText(text)) {
    return text;
  }

  const preferredTopic = text.match(/^Matches preferred topic:\s*(.+)$/i);
  if (preferredTopic) {
    return `命中偏好 topic：${localizeShortLabel(preferredTopic[1])}`;
  }

  const topic = text.match(/^topic(?: match)?:\s*(.+)$/i);
  if (topic) {
    return `命中 topic：${localizeShortLabel(topic[1])}`;
  }

  const keyword = text.match(/^Strong keyword match:\s*(.+)$/i);
  if (keyword) {
    return `强关键词匹配：${localizeList(keyword[1])}`;
  }

  const strongTopic = text.match(/^Strong match for (.+) topic$/i);
  if (strongTopic) {
    return `与 ${localizeShortLabel(strongTopic[1])} topic 强匹配`;
  }

  if (/primary topic alignment with ai/i.test(text)) {
    return "主要主题与 AI 方向一致";
  }
  if (/developer[- ]tools/i.test(text) && /sdk|cli|ui/i.test(text)) {
    return "通过 SDK、CLI、UI 体现出较强开发者工具属性";
  }
  if (/primary language/i.test(text) && /preferred/i.test(text)) {
    return "主要开发语言符合当前发现偏好";
  }
  if (/stars/i.test(text) && /minstars/i.test(text)) {
    return "Stars 数量满足当前最低门槛";
  }
  if (/readme|description/i.test(text) && /keyword/i.test(text)) {
    return "README 或项目描述包含偏好关键词";
  }

  const shortLabel = localizeShortLabel(text);
  if (shortLabel !== text || /^[a-z0-9+#./ -]{2,40}$/i.test(text)) {
    return shortLabel;
  }

  return "与当前发现偏好存在相关信号";
}

function localizeList(value: string) {
  return value
    .split(/[,，/]+/)
    .map(localizeShortLabel)
    .filter(Boolean)
    .join("、");
}

function localizeShortLabel(value: string) {
  const clean = value.trim().replace(/^topic:\s*/i, "");
  const displayLabel = clean.match(/^(?:命中偏好 topic|命中 topic|强关键词匹配)：(.+)$/);
  if (displayLabel) {
    return displayLabel[1].trim();
  }

  const normalized = clean.toLowerCase();
  return preferenceLabels[normalized] ?? clean;
}

function looksLikeTemplateSummary(value: string) {
  return (
    /原始描述[:：]/.test(value) ||
    /适合进一步评估其在当前发现配置中的价值/.test(value) ||
    /当前约[\s\d,]+个 stars/.test(value) ||
    /与 .*等发现偏好相关/.test(value)
  );
}

function normalizeFunctionalSourceText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function inferFunctionalPurpose(text: string, repo: RepoSummary) {
  const combined = `${text} ${repo.description} ${repo.topics.join(" ")} ${repo.name} ${repo.fullName}`.toLowerCase();

  if (/(platform|framework|toolkit|sdk).{0,40}(build|building|develop|create).{0,40}(llm|ai|model).{0,30}(app|apps|application|applications|agent)/.test(combined)) {
    return "用于构建 LLM / AI 应用的开发平台";
  }

  if (/(platform|framework|toolkit|sdk).{0,40}(llm|ai|model).{0,30}(app|apps|application|applications|agent)/.test(combined)) {
    return "用于构建 LLM / AI 应用的开发平台";
  }

  if (/(build|building|develop|create).{0,40}(llm|ai|model).{0,30}(app|apps|application|applications|agent)/.test(combined)) {
    return "用于构建 LLM / AI 应用";
  }

  if (/(ai|agent).{0,30}(workflow|automation|orchestration).{0,30}(tool|platform|developer|devtool)/.test(combined)) {
    return "用于开发和编排 AI 工作流";
  }

  if (/(workflow|automation|orchestration).{0,30}(developer|tool|platform|devtool)/.test(combined)) {
    return "用于搭建自动化工作流";
  }

  if (/(rag|retrieval).{0,40}(knowledge ?base|document|docs|search|index)/.test(combined) || /(knowledge ?base).{0,40}(rag|retrieval|embedding|vector|self[- ]?host)/.test(combined)) {
    return "用于构建 RAG 知识库和文档检索";
  }

  if (/(page|web|website|document).{0,30}(index|indexing|search)/.test(combined)) {
    return "用于网页或文档索引检索";
  }

  if (/(agent|ai).{0,30}(eyes|browse|browser|internet|web)/.test(combined)) {
    return "让 AI Agent 浏览和理解网页内容";
  }

  if (/(browser|playwright|puppeteer|selenium).{0,30}(automation|agent|testing|scrape|crawl)/.test(combined)) {
    return "用于浏览器自动化和网页操作";
  }

  if (/(api gateway|gateway|proxy).{0,40}(llm|ai|openai|model|provider)/.test(combined)) {
    return "用于统一代理和管理 AI 模型 API";
  }

  return "";
}

function inferFunctionalDomain(text: string, repo: RepoSummary) {
  const combined = `${text} ${repo.topics.join(" ")} ${repo.name} ${repo.fullName}`.toLowerCase();

  if (/(sdk|toolkit|library|framework|platform)/.test(combined) && /(ai|llm|model|openai|anthropic|chatgpt|application|applications)/.test(combined)) {
    return "AI 应用开发框架 / 工具包";
  }

  if (/(rag|retrieval|embedding|vector|knowledge ?base|knowledgebase|semantic search|search index|indexing)/.test(combined)) {
    if (/(page|web|website|browser|crawl|crawler|scrape|document)/.test(combined)) {
      return "网页索引 / RAG 知识库工具";
    }
    return "RAG / 知识库工具";
  }

  if (/(agent|agents)/.test(combined) && /(workflow|automation|orchestration)/.test(combined)) {
    return "AI Agent 工作流工具";
  }

  if (/(workflow|automation|orchestration)/.test(combined) && /(tool|developer|devtool|cli|ui|dashboard|studio|platform)/.test(combined)) {
    return "AI 工作流开发工具";
  }

  if (/(agent|agents)/.test(combined) && /(memory|memori)/.test(combined)) {
    return "Agent 记忆管理工具";
  }

  if (/(browser|playwright|puppeteer|selenium|crawl|crawler|scrape|scraper|extension)/.test(combined)) {
    return "浏览器自动化 / 抓取工具";
  }

  if (/(monitor|observability|metrics|logging|alert|trace)/.test(combined)) {
    return "监控 / 观测工具";
  }

  if (/(api gateway|gateway|proxy)/.test(combined)) {
    return "API 代理 / 网关工具";
  }

  if (/(dashboard|studio|console|panel|admin|(?:^|[^a-z0-9])ui(?:$|[^a-z0-9]))/.test(combined)) {
    return "控制台 / 仪表盘";
  }

  if (/(self[- ]?host|hosting|deployment|docker|kubernetes)/.test(combined)) {
    return "自托管 / 部署工具";
  }

  if (/(sdk|toolkit|library|framework|platform)/.test(combined)) {
    return "开发框架 / 工具包";
  }

  if (/cli/.test(combined)) {
    return "命令行工具";
  }

  if (/extension/.test(combined)) {
    return "浏览器扩展";
  }

  if (/(generator|generate|scaffold)/.test(combined)) {
    return "生成器 / 脚手架";
  }

  if (/(database|db|orm|sql)/.test(combined)) {
    return "数据库 / 数据层工具";
  }

  return "";
}

function inferFunctionalCapabilities(text: string, repo: RepoSummary) {
  const combined = `${text} ${repo.topics.join(" ")}`.toLowerCase();
  const capabilities = [
    /(model|llm|ai-powered|openai|anthropic|chatgpt)/.test(combined) ? "模型接入" : "",
    /(stream|streaming)/.test(combined) ? "流式响应" : "",
    /(react|svelte|vue|solid|next|frontend|(?:^|[^a-z0-9])ui(?:$|[^a-z0-9]))/.test(combined) ? "前端集成" : "",
    /(rag|retrieval|embedding|vector|search|index|knowledge)/.test(combined) ? "检索与索引" : "",
    /(agent|workflow|orchestration)/.test(combined) ? "工作流编排" : "",
    /(automation)/.test(combined) ? "自动化执行" : "",
    /(self[- ]?host|docker|deployment|hosting)/.test(combined) ? "自托管部署" : "",
    /(api|integration|webhook)/.test(combined) ? "API 集成" : "",
    /(monitor|observability|metrics|logging|alert|trace)/.test(combined) ? "监控告警" : "",
    /(provider|multi[- ]?model|openai compatible)/.test(combined) ? "多模型支持" : ""
  ].filter(Boolean);

  return [...new Set(capabilities)];
}

function inferFunctionalAudience(
  text: string,
  repo: RepoSummary,
  matchedPreferences: string[]
) {
  const combined = `${text} ${matchedPreferences.join(" ")}`.toLowerCase();

  if (/(self[- ]?host|deployment|docker|private)/.test(combined)) {
    return "私有化部署团队";
  }
  if (/(monitor|observability|metrics|logging|alert|trace)/.test(combined)) {
    return "运维或平台团队";
  }
  if (/(agent|workflow|automation)/.test(combined)) {
    return "AI 产品开发团队";
  }
  if (/(sdk|toolkit|library|framework|platform|cli|ui|developer-tools|developer|tool)/.test(combined) || repo.primaryLanguage !== "Unknown") {
    return "开发者";
  }

  return "";
}

function formatAudience(audience: string) {
  return /^[A-Za-z0-9+#]/.test(audience) ? `适合 ${audience}` : `适合${audience}`;
}
