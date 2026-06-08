import { NextResponse } from "next/server";
import { listKnowledgeSyncs } from "@/server/store";

export async function GET() {
  return NextResponse.json(await listKnowledgeSyncs());
}
