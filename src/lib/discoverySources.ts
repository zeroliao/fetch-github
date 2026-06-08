import type { DiscoverySourceConfig, DiscoverySourceId } from "./types";

export interface DiscoverySourceDefinition {
  id: DiscoverySourceId;
  label: string;
  authority: "github_official" | "third_party" | "derived";
  capability: "implemented" | "planned_adapter" | "quality_signal";
  defaultWeight: number;
  description: string;
}

export const discoverySourceCatalog: DiscoverySourceDefinition[] = [
  {
    id: "github_search_preferences",
    label: "GitHub Search 偏好查询",
    authority: "github_official",
    capability: "implemented",
    defaultWeight: 1,
    description: "基于关键词、topic、语言和硬过滤条件生成官方 GitHub Search 查询。"
  },
  {
    id: "github_topics",
    label: "GitHub Topics",
    authority: "github_official",
    capability: "implemented",
    defaultWeight: 1.08,
    description: "重点扫描配置 topic 下的项目，适合 AI、agent、developer-tools 等主题发现。"
  },
  {
    id: "github_search_stars",
    label: "GitHub 高 Star",
    authority: "github_official",
    capability: "implemented",
    defaultWeight: 1.04,
    description: "按 stars 排序扫描高关注项目，偏成熟度和生态影响力。"
  },
  {
    id: "github_search_recent_growth",
    label: "GitHub 近期活跃",
    authority: "derived",
    capability: "implemented",
    defaultWeight: 1.12,
    description: "用 pushed/created 时间窗口近似发现近期增长项目，并通过快照继续计算真实增速。"
  },
  {
    id: "github_trending",
    label: "GitHub Trending",
    authority: "github_official",
    capability: "planned_adapter",
    defaultWeight: 1.15,
    description: "GitHub 官方 Trending 页面，适合补充今日/本周/月度热度。"
  },
  {
    id: "github_explore",
    label: "GitHub Explore",
    authority: "github_official",
    capability: "planned_adapter",
    defaultWeight: 1.1,
    description: "GitHub Explore、Collections 和官方推荐主题，适合人工精选信号。"
  },
  {
    id: "ossinsight_trending",
    label: "OSS Insight Trending",
    authority: "third_party",
    capability: "planned_adapter",
    defaultWeight: 1.12,
    description: "第三方 GitHub 趋势 API，可替代页面抓取 Trending。"
  },
  {
    id: "gharchive_velocity",
    label: "GH Archive 增速",
    authority: "third_party",
    capability: "planned_adapter",
    defaultWeight: 1.14,
    description: "基于 GitHub 公开事件归档计算 star/fork/issue/PR 增速。"
  },
  {
    id: "openssf_scorecard",
    label: "OpenSSF Scorecard",
    authority: "third_party",
    capability: "quality_signal",
    defaultWeight: 0.98,
    description: "用于安全与维护质量评分，不直接扩大候选池。"
  },
  {
    id: "ecosystems_usage",
    label: "ecosyste.ms 使用度",
    authority: "third_party",
    capability: "quality_signal",
    defaultWeight: 1.02,
    description: "用于依赖生态、包发布和真实使用度评分，不直接扩大候选池。"
  }
];

export function defaultDiscoverySources(): DiscoverySourceConfig[] {
  return discoverySourceCatalog.map((source) => ({
    id: source.id,
    enabled: ["implemented", "quality_signal"].includes(source.capability),
    weight: source.defaultWeight
  }));
}

export function normalizeDiscoverySources(
  sources: DiscoverySourceConfig[] | undefined
): DiscoverySourceConfig[] {
  const byId = new Map((sources ?? []).map((source) => [source.id, source]));
  return discoverySourceCatalog.map((definition) => {
    const source = byId.get(definition.id);
    return {
      id: definition.id,
      enabled: source?.enabled ?? ["implemented", "quality_signal"].includes(definition.capability),
      weight: source?.weight ?? definition.defaultWeight
    };
  });
}

export function sourceDefinition(id: DiscoverySourceId) {
  return discoverySourceCatalog.find((source) => source.id === id);
}
