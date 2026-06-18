import type { DiscoveryProfile } from "@/lib/types";
import { normalizeDiscoverySources, sourceDefinition } from "@/lib/discoverySources";

export interface GitHubSearchQueryPlan {
  sourceId: string;
  sourceLabel: string;
  query: string;
  weight: number;
  sort: "stars" | "forks" | "updated";
  order: "asc" | "desc";
}

export function buildGitHubSearchQueryPlans(profile: DiscoveryProfile): GitHubSearchQueryPlan[] {
  const { preferences } = profile.config;
  const sources = normalizeDiscoverySources(profile.config.sources);
  const baseFilters = [
    preferences.excludeArchived ? "archived:false" : "",
    preferences.excludeForks ? "fork:false" : "",
    preferences.minStars > 0 ? `stars:>=${preferences.minStars}` : ""
  ].filter(Boolean);
  const enabled = new Set(sources.filter((source) => source.enabled).map((source) => source.id));
  const plans: GitHubSearchQueryPlan[] = [];

  function addPlan(
    sourceId: GitHubSearchQueryPlan["sourceId"],
    query: string,
    sort: GitHubSearchQueryPlan["sort"] = "stars"
  ) {
    const source = sources.find((item) => item.id === sourceId);
    if (!source?.enabled) return;
    plans.push({
      sourceId,
      sourceLabel: sourceDefinition(source.id)?.label ?? source.id,
      query,
      weight: source.weight,
      sort,
      order: "desc"
    });
  }

  if (enabled.has("github_search_preferences")) {
    for (const keyword of preferences.keywords) {
      addPlan("github_search_preferences", [keyword, ...baseFilters].join(" "));
    }
    for (const language of Object.keys(preferences.languages)) {
      addPlan("github_search_preferences", [`language:${language}`, ...baseFilters].join(" "));
    }
  }

  if (enabled.has("github_topics")) {
    for (const topic of preferences.topics) {
      addPlan("github_topics", [`topic:${topic}`, ...baseFilters].join(" "));
    }
  }

  if (enabled.has("github_explore")) {
    const exploreTopics = uniqueStrings([
      ...preferences.topics,
      ...preferences.keywords,
      "awesome",
      "developer-tools",
      "saas",
      "ai-agent"
    ]).slice(0, 8);
    for (const topic of exploreTopics) {
      addPlan("github_explore", [`topic:${topic}`, ...baseFilters].join(" "), "stars");
    }
    for (const keyword of preferences.keywords.slice(0, 4)) {
      addPlan("github_explore", [`awesome ${keyword}`, ...baseFilters].join(" "), "stars");
    }
  }

  if (enabled.has("github_search_stars")) {
    const topicOrKeywords = [...preferences.topics.map((topic) => `topic:${topic}`), ...preferences.keywords];
    for (const query of topicOrKeywords.slice(0, 6)) {
      addPlan("github_search_stars", [query, ...baseFilters].join(" "), "stars");
    }
  }

  if (enabled.has("github_search_recent_growth")) {
    const since = formatDate(daysAgo(preferences.pushedWithinDays));
    const recencyFilters = [...baseFilters, `pushed:>=${since}`];
    for (const topic of preferences.topics) {
      addPlan("github_search_recent_growth", [`topic:${topic}`, ...recencyFilters].join(" "), "updated");
    }
    for (const keyword of preferences.keywords.slice(0, 4)) {
      addPlan("github_search_recent_growth", [keyword, ...recencyFilters].join(" "), "updated");
    }
  }

  return dedupePlans(plans);
}

export function buildGitHubSearchQueries(profile: DiscoveryProfile): string[] {
  return buildGitHubSearchQueryPlans(profile).map((plan) => plan.query);
}

function dedupePlans(plans: GitHubSearchQueryPlan[]) {
  const seen = new Set<string>();
  return plans.filter((plan) => {
    const key = `${plan.sourceId}:${plan.query}:${plan.sort}:${plan.order}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Math.max(1, days));
  return date;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
