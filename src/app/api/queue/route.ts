import { NextResponse } from "next/server";
import { getQueueStats } from "@/server/store";

export async function GET() {
  return NextResponse.json(await getQueueStats());
}
