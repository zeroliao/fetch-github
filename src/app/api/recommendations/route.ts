import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { listRecommendations } from "@/server/store";
import type { Recommendation } from "@/lib/types";

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const wantsPaged =
    url.searchParams.has("page") ||
    url.searchParams.has("pageSize") ||
    url.searchParams.has("profileId") ||
    url.searchParams.has("status") ||
    url.searchParams.has("preference") ||
    url.searchParams.has("opportunity") ||
    url.searchParams.has("group") ||
    url.searchParams.has("clusterKey") ||
    url.searchParams.has("ids") ||
    url.searchParams.has("sort");

  const recommendations = await listRecommendations();
  if (!wantsPaged) {
    return NextResponse.json(recommendations);
  }

  const page = positiveInteger(url.searchParams.get("page"), 1);
  const pageSize = Math.min(positiveInteger(url.searchParams.get("pageSize"), 50), 200);
  const profileId = url.searchParams.get("profileId") ?? "";
  const status = url.searchParams.get("status") ?? "visible";
  const preference = url.searchParams.get("preference") ?? "all";
  const opportunity = url.searchParams.get("opportunity") ?? "all";
  const group = url.searchParams.get("group") ?? "all";
  const clusterKey = url.searchParams.get("clusterKey") ?? "";
  const ids = new Set(
    (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const sort = url.searchParams.get("sort") ?? "rank";
  const direction = url.searchParams.get("direction") === "asc" ? "asc" : "desc";

  const filtered = recommendations
    .filter((item) => !profileId || item.profileId === profileId)
    .filter((item) => ids.size === 0 || ids.has(item.id))
    .filter((item) => recommendationMatchesStatus(item, status))
    .filter((item) => recommendationMatchesPreference(item, preference))
    .filter((item) => recommendationMatchesOpportunity(item, opportunity))
    .filter((item) => recommendationMatchesGroup(item, group, clusterKey))
    .sort((left, right) => compareRecommendations(left, right, sort, direction));
  const offset = (page - 1) * pageSize;

  return NextResponse.json({
    items: filtered.slice(offset, offset + pageSize),
    total: filtered.length,
    page,
    pageSize
  });
}

function recommendationMatchesStatus(recommendation: Recommendation, status: string) {
  if (status === "all") {
    return true;
  }
  if (status === "visible") {
    return recommendation.status !== "hidden";
  }
  return recommendation.status === status;
}

function recommendationMatchesPreference(recommendation: Recommendation, preference: string) {
  if (preference === "all") {
    return true;
  }
  if (preference === "unrated") {
    return recommendation.status !== "liked" && recommendation.status !== "disliked";
  }
  return recommendation.status === preference;
}

function recommendationMatchesOpportunity(recommendation: Recommendation, opportunity: string) {
  const action = recommendation.opportunity?.suggestedAction;
  if (opportunity === "all") {
    return true;
  }
  if (opportunity === "has_opportunity") {
    return Boolean(action);
  }
  if (opportunity === "no_opportunity") {
    return !action;
  }
  return action === opportunity;
}

function recommendationMatchesGroup(recommendation: Recommendation, group: string, clusterKey: string) {
  if (clusterKey) {
    return recommendation.cluster?.key === clusterKey;
  }
  if (group === "all") {
    return true;
  }
  if (group === "grouped") {
    return Boolean(recommendation.cluster?.key);
  }
  return !recommendation.cluster?.key;
}

function compareRecommendations(
  left: Recommendation,
  right: Recommendation,
  sort: string,
  direction: "asc" | "desc"
) {
  const sign = direction === "asc" ? 1 : -1;
  const rankFallback = left.rank - right.rank;
  if (sort === "score") {
    return sign * (left.scores.final - right.scores.final) || rankFallback;
  }
  if (sort === "stars") {
    return sign * (left.repo.stars - right.repo.stars) || rankFallback;
  }
  return sign * (left.rank - right.rank) || rankFallback;
}

function positiveInteger(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
