import { NextResponse } from "next/server";
import { listRecommendations } from "@/server/store";

export async function GET() {
  return NextResponse.json(await listRecommendations());
}
