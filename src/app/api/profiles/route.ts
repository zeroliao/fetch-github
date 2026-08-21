import { NextResponse } from "next/server";
import { profileSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { createProfile, listProfiles } from "@/server/store";

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  return NextResponse.json(await listProfiles());
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const parsed = profileSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { errors: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const profile = await createProfile(parsed.data);
  return NextResponse.json(profile, { status: 201 });
}
