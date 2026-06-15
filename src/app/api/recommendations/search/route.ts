import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { searchRecommendations } from "@/server/recommendationSearch";

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const profileId = url.searchParams.get("profileId") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 100);

  return NextResponse.json(await searchRecommendations({ query, profileId, limit }));
}
