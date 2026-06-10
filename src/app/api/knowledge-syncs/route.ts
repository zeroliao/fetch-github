import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { listKnowledgeSyncs } from "@/server/store";

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  return NextResponse.json(await listKnowledgeSyncs());
}
