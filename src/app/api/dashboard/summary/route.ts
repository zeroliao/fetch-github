import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import {
  getAppSettings,
  getQueueStats,
  listAiProviders,
  listRecommendations,
  listScanJobs
} from "@/server/store";

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const [settings, queueStats, providers, recommendations, jobs] = await Promise.all([
    getAppSettings(),
    getQueueStats(),
    listAiProviders(),
    listRecommendations(),
    listScanJobs()
  ]);

  return NextResponse.json({
    settings,
    queueStats,
    providersCount: providers.length,
    visibleRecommendationsByProfile: recommendations.reduce<Record<string, number>>(
      (counts, recommendation) => {
        if (recommendation.status !== "hidden") {
          counts[recommendation.profileId] = (counts[recommendation.profileId] ?? 0) + 1;
        }
        return counts;
      },
      {}
    ),
    latestJob: jobs[0] ?? null
  });
}
