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
  if (summary && containsChineseText(summary) && !isLegacyRawDescriptionSummary(summary)) {
    return summary;
  }

  return buildChineseRepoSummary(repo, matchedPreferences);
}

export function buildChineseRepoSummary(
  repo: RepoSummary,
  matchedPreferences: string[] = []
) {
  const language = repo.primaryLanguage && repo.primaryLanguage !== "Unknown"
    ? `${repo.primaryLanguage} 项目`
    : "GitHub 项目";
  const matched = matchedPreferences.map(localizeShortLabel).filter(Boolean).slice(0, 4);
  const topics = repo.topics.map(localizeShortLabel).filter(Boolean).slice(0, 3);
  const focus = matched.length
    ? `，与 ${matched.join("、")} 等发现偏好相关`
    : topics.length
      ? `，主题包含 ${topics.join("、")}`
      : "";
  const stars = repo.stars > 0
    ? `，当前约 ${repo.stars.toLocaleString("zh-CN")} 个 stars`
    : "";
  const pushedAt = formatDate(repo.pushedAt);
  const freshness = pushedAt ? `，最近推送于 ${pushedAt}` : "";

  return `${repo.fullName} 是一个 ${language}${focus}${stars}${freshness}，适合进一步评估其在当前发现配置中的价值。`;
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

function isLegacyRawDescriptionSummary(value: string) {
  return /原始描述[:：]/.test(value);
}

function formatDate(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return "";
  }

  return new Date(time).toLocaleDateString("zh-CN");
}
