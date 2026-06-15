import type { Recommendation, RecommendationCluster, RepoSummary } from "./types";

type ClusterRule = {
  key: string;
  label: string;
  reason: string;
  terms: string[];
};

const clusterRules: ClusterRule[] = [
  {
    key: "ai-agent-workflow",
    label: "AI Agent / 工作流",
    reason: "包含 agent、workflow、automation 等自动化机会信号。",
    terms: ["agent", "agents", "workflow", "automation", "autonomous", "multi-agent"]
  },
  {
    key: "rag-knowledge-base",
    label: "RAG / 知识库",
    reason: "包含 rag、knowledge、vector、retrieval 等知识库与检索信号。",
    terms: ["rag", "knowledge", "vector", "retrieval", "embedding", "search"]
  },
  {
    key: "mcp-plugin-extension",
    label: "MCP / 插件扩展",
    reason: "包含 mcp、plugin、extension 等可扩展生态信号。",
    terms: ["mcp", "plugin", "plugins", "extension", "extensions", "marketplace"]
  },
  {
    key: "developer-platform",
    label: "开发者平台 / API",
    reason: "包含 api、sdk、cli、developer tool 等开发者商业化信号。",
    terms: ["api", "sdk", "cli", "developer", "devtool", "devtools", "integration"]
  },
  {
    key: "self-hosted-deploy",
    label: "私有化部署 / 运维",
    reason: "包含 self-hosted、deploy、monitoring 等交付和运维信号。",
    terms: ["self-hosted", "selfhosted", "deploy", "deployment", "monitoring", "observability"]
  },
  {
    key: "browser-automation",
    label: "浏览器自动化",
    reason: "包含 browser、crawler、scraping、playwright 等自动化获客或数据采集信号。",
    terms: ["browser", "crawler", "scraping", "scraper", "playwright", "browser-use"]
  },
  {
    key: "data-analytics-dashboard",
    label: "数据分析 / Dashboard",
    reason: "包含 dashboard、analytics、report 等可视化和数据产品信号。",
    terms: ["dashboard", "analytics", "report", "metrics", "chart", "bi"]
  }
];

export function inferRecommendationCluster(
  repo: RepoSummary,
  opportunityType?: string
): RecommendationCluster {
  const text = normalizeText(
    `${repo.fullName} ${repo.description} ${repo.topics.join(" ")} ${repo.primaryLanguage} ${opportunityType ?? ""}`
  );
  const matchedRules = clusterRules
    .map((rule) => ({
      rule,
      hits: rule.terms.filter((term) => text.includes(term))
    }))
    .filter((item) => item.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length);

  const best = matchedRules[0];
  if (best) {
    return {
      key: best.rule.key,
      label: best.rule.label,
      reason: best.rule.reason,
      representativeTerms: best.hits.slice(0, 5)
    };
  }

  const language = repo.primaryLanguage && repo.primaryLanguage !== "Unknown"
    ? repo.primaryLanguage
    : "Other";
  return {
    key: `language-${slugify(language)}`,
    label: `${language} 综合机会`,
    reason: "未命中特定主题规则，按主要语言进行轻量分组。",
    representativeTerms: [language].filter(Boolean)
  };
}

export function annotateRecommendationClusters(
  recommendations: Recommendation[]
): Recommendation[] {
  const grouped = new Map<string, Array<Recommendation & { cluster: RecommendationCluster }>>();
  for (const recommendation of recommendations) {
    const cluster =
      recommendation.cluster ??
      inferRecommendationCluster(recommendation.repo, recommendation.opportunity?.type);
    const next = {
      ...recommendation,
      cluster
    };
    grouped.set(cluster.key, [...(grouped.get(cluster.key) ?? []), next]);
  }

  return [...grouped.values()]
    .flatMap((items) =>
      items
        .sort((a, b) => b.scores.final - a.scores.final)
        .map((item, index) => ({
          ...item,
          cluster: {
            ...item.cluster,
            size: items.length,
            rankInCluster: index + 1
          }
        }))
    )
    .sort((a, b) => b.scores.final - a.scores.final)
    .map((item, index) => ({
      ...item,
      rank: index + 1
    }));
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/_/g, "-");
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "other";
}
