import { NextResponse } from "next/server";
import { getDashboardSnapshot } from "@/server/store";

export async function GET() {
  return NextResponse.json(await getDashboardSnapshot());
}
