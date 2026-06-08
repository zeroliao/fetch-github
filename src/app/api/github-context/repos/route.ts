import { NextResponse } from "next/server";
import { listGithubRepos } from "@/server/store";

export async function GET() {
  return NextResponse.json(await listGithubRepos());
}
