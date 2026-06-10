import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { listRecommendations } from "@/server/store";

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  return NextResponse.json(await listRecommendations());
}
