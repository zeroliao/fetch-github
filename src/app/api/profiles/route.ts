import { NextResponse } from "next/server";
import { profileSchema } from "@/lib/validation";
import { createProfile, getAiProvider, listProfiles } from "@/server/store";

export async function GET() {
  return NextResponse.json(await listProfiles());
}

export async function POST(request: Request) {
  const parsed = profileSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  const aiValidation = await validateProfileAiProviders(parsed.data.config.ai);
  if (aiValidation) {
    return NextResponse.json({ error: aiValidation }, { status: 400 });
  }

  const profile = await createProfile(parsed.data);
  return NextResponse.json(profile, { status: 201 });
}

async function validateProfileAiProviders(ai: {
  chatProviderId: string;
  embeddingProviderId: string;
}) {
  const [chatProvider, embeddingProvider] = await Promise.all([
    getAiProvider(ai.chatProviderId),
    getAiProvider(ai.embeddingProviderId)
  ]);

  if (!chatProvider) {
    return "Chat 模型配置不存在。";
  }
  if (!embeddingProvider) {
    return "Embedding 模型配置不存在。";
  }
  if (chatProvider.kind !== "chat") {
    return "Chat 模型配置类型不正确。";
  }
  if (embeddingProvider.kind !== "embedding") {
    return "Embedding 模型配置类型不正确。";
  }
  if (!chatProvider.enabled || !embeddingProvider.enabled) {
    return "发现配置只能绑定已启用的 AI 配置。";
  }

  return null;
}
