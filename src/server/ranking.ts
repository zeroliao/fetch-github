import { calculateFinalScore, clampScore, SCORE_VERSION } from "@/lib/scoring";
import type {
  DiscoveryProfile,
  PreferenceSignal,
  Recommendation,
  RepoSummary,
  UserGitHubRepo
} from "@/lib/types";
import type { RepoAnalysisResult } from "./llmAnalysis";

export function repoPassesHardFilters(
  repo: RepoSummary,
  profile: DiscoveryProfile
): boolean {
  const { preferences } = profile.config;

  if (preferences.excludeArchived && repo.archived) {
    return false;
  }

  if (preferences.excludeForks && repo.fork) {
    return false;
  }

  if (repo.stars < preferences.minStars) {
    return false;
  }

  const topics = repo.topics ?? [];
  const text = `${repo.fullName} ${repo.description} ${topics.join(" ")}`.toLowerCase();
  if (preferences.excludeKeywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
    return false;
  }

  const pushedAt = new Date(repo.pushedAt).getTime();
  const maxAgeMs = preferences.pushedWithinDays * 24 * 60 * 60 * 1000;
  if (Number.isFinite(pushedAt) && Date.now() - pushedAt > maxAgeMs) {
    return false;
  }

  return true;
}

export function scoreRepo(
  repo: RepoSummary,
  profile: DiscoveryProfile,
  preferenceSignals: PreferenceSignal[] = []
) {
  const { preferences } = profile.config;
  const topics = repo.topics ?? [];
  const text = `${repo.fullName} ${repo.description} ${topics.join(" ")}`.toLowerCase();

  const keywordHits = preferences.keywords.filter((keyword) =>
    text.includes(keyword.toLowerCase())
  ).length;
  const topicHits = preferences.topics.filter((topic) =>
    topics.map((value) => value.toLowerCase()).includes(topic.toLowerCase())
  ).length;
  const languageWeight = preferences.languages[repo.primaryLanguage] ?? 0;
  const starScore = Math.min(1, Math.log10(repo.stars + 1) / 5);
  const freshnessScore = calculateFreshnessScore(repo.pushedAt);
  const qualityScore = repo.description ? 0.7 : 0.35;

  const relevanceScore = clampScore(
    keywordHits * 0.18 + topicHits * 0.16 + languageWeight * 0.18
  );
  const ruleScore = clampScore(
    relevanceScore * 0.5 + starScore * 0.25 + freshnessScore * 0.15 + qualityScore * 0.1
  );
  const githubContextFit = clampScore(relevanceScore * 0.75 + languageWeight * 0.08);
  const llmMatchScore = clampScore(ruleScore * 0.85 + relevanceScore * 0.15);
  const feedbackScore = calculateFeedbackScore(repo, preferenceSignals);
  const finalScore = calculateFinalScore({
    ruleScore,
    githubContextFit,
    llmMatchScore,
    feedbackScore
  });

  return {
    ruleScore,
    githubContextFit,
    llmMatchScore,
    feedbackScore,
    finalScore,
    reasons: buildReasons(repo, profile, keywordHits, topicHits)
  };
}

export function buildRecommendation(
  repo: RepoSummary,
  profile: DiscoveryProfile,
  rank: number,
  analysis?: RepoAnalysisResult,
  preferenceSignals: PreferenceSignal[] = [],
  userRepos: UserGitHubRepo[] = []
): Recommendation {
  const score = scoreRepo(repo, profile, preferenceSignals);
  const relatedUserRepos = findRelatedUserRepos(repo, userRepos);
  const githubContextFit = clampScore(
    Math.max(score.githubContextFit, relatedUserRepos[0]?.score ?? 0)
  );
  const llmMatchScore = analysis?.match_score ?? score.llmMatchScore;
  const finalScore = calculateFinalScore({
    ruleScore: score.ruleScore,
    githubContextFit,
    llmMatchScore,
    feedbackScore: score.feedbackScore
  });

  return {
    id: `rec-${profile.id}-${repo.id}`,
    profileId: profile.id,
    rank,
    repo,
    scores: {
      rule: score.ruleScore,
      githubContextFit,
      llmMatch: llmMatchScore,
      feedback: score.feedbackScore,
      final: finalScore,
      scoreVersion: SCORE_VERSION
    },
    summary:
      analysis?.summary || repo.description || "Repository metadata matched the configured discovery profile.",
    reasons: analysis?.recommendation_reason
      ? [analysis.recommendation_reason, ...score.reasons]
      : score.reasons,
    risks: analysis?.risks.length
      ? analysis.risks
      : repo.openIssues > 500
        ? ["High open issue count may need closer review."]
        : [],
    matchedPreferences: analysis?.matched_preferences.length
      ? analysis.matched_preferences
      : inferMatchedPreferences(repo, profile),
    relatedUserRepos,
    status: "new",
    createdAt: new Date().toISOString()
  };
}

function calculateFreshnessScore(pushedAt: string): number {
  const time = new Date(pushedAt).getTime();
  if (!Number.isFinite(time)) {
    return 0;
  }

  const days = (Date.now() - time) / (24 * 60 * 60 * 1000);
  if (days <= 7) {
    return 1;
  }
  if (days <= 30) {
    return 0.8;
  }
  if (days <= 90) {
    return 0.55;
  }
  if (days <= 180) {
    return 0.35;
  }
  return 0.1;
}

function buildReasons(
  repo: RepoSummary,
  profile: DiscoveryProfile,
  keywordHits: number,
  topicHits: number
): string[] {
  const reasons = [
    `Matched ${keywordHits} configured keywords and ${topicHits} configured topics.`,
    `${repo.primaryLanguage} language signal with ${repo.stars.toLocaleString()} stars.`,
    `Recently pushed at ${new Date(repo.pushedAt).toLocaleDateString()}.`
  ];

  if (profile.config.preferences.languages[repo.primaryLanguage]) {
    reasons.push(`Language ${repo.primaryLanguage} is weighted in this profile.`);
  }

  return reasons;
}

function inferMatchedPreferences(repo: RepoSummary, profile: DiscoveryProfile): string[] {
  const text = `${repo.fullName} ${repo.description}`.toLowerCase();
  const keywords = profile.config.preferences.keywords.filter((keyword) =>
    text.includes(keyword.toLowerCase())
  );
  const repoTopics = repo.topics ?? [];
  const topics = profile.config.preferences.topics.filter((topic) =>
    repoTopics.map((value) => value.toLowerCase()).includes(topic.toLowerCase())
  );

  return [...new Set([...keywords, ...topics, repo.primaryLanguage])].filter(Boolean);
}

function calculateFeedbackScore(repo: RepoSummary, signals: PreferenceSignal[]) {
  if (signals.length === 0) {
    return 0;
  }

  const topics = new Set(repo.topics.map((topic) => topic.toLowerCase()));
  const text = `${repo.fullName} ${repo.description}`.toLowerCase();
  const total = signals.reduce((sum, signal) => {
    if (signal.signalType === "language" && signal.value === repo.primaryLanguage) {
      return sum + signal.weight;
    }
    if (signal.signalType === "topic" && topics.has(signal.value.toLowerCase())) {
      return sum + signal.weight;
    }
    if (signal.signalType === "keyword" && text.includes(signal.value.toLowerCase())) {
      return sum + signal.weight;
    }
    return sum;
  }, 0);

  return clampScore((total + 1) / 2);
}

function findRelatedUserRepos(
  repo: RepoSummary,
  userRepos: UserGitHubRepo[]
): Recommendation["relatedUserRepos"] {
  const repoTopics = new Set(repo.topics.map((topic) => topic.toLowerCase()));
  const repoText = `${repo.fullName} ${repo.description}`.toLowerCase();

  return userRepos
    .filter((userRepo) => userRepo.selectedForContext)
    .map((userRepo) => {
      const sharedTopics = userRepo.topics.filter((topic) =>
        repoTopics.has(topic.toLowerCase())
      );
      const languageMatch =
        userRepo.primaryLanguage !== "Unknown" &&
        userRepo.primaryLanguage === repo.primaryLanguage;
      const nameTokens = userRepo.fullName
        .toLowerCase()
        .split(/[^a-z0-9+#.-]+/i)
        .filter((token) => token.length >= 3);
      const keywordHits = nameTokens.filter((token) => repoText.includes(token)).length;
      const score = clampScore(
        sharedTopics.length * 0.22 + (languageMatch ? 0.28 : 0) + keywordHits * 0.08
      );
      const reasons = [
        sharedTopics.length ? `共享 topic：${sharedTopics.slice(0, 3).join(", ")}` : "",
        languageMatch ? `同为 ${repo.primaryLanguage}` : "",
        keywordHits ? "名称或描述存在相似关键词" : ""
      ].filter(Boolean);

      return {
        fullName: userRepo.fullName,
        reason: reasons.join("；") || "与当前发现偏好存在弱相关。",
        score
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
