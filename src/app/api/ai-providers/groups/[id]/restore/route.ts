import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { restoreAiProviderGroup } from "@/server/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const group = await restoreAiProviderGroup(id);
  return group
    ? NextResponse.json(group)
    : NextResponse.json(
        { error: "Archived Provider not found" },
        { status: 404 },
      );
}
