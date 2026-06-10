import { NextResponse } from "next/server";
import { profileSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { getAiProvider, updateProfile } from "@/server/store";

const patchSchema = profileSchema.partial();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const parsed = patchSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.config?.ai) {
    const aiValidation = await validateProfileAiProviders(parsed.data.config.ai);
    if (aiValidation) {
      return NextResponse.json({ error: aiValidation }, { status: 400 });
    }
  }

  const profile = await updateProfile(id, parsed.data);
  if (!profile) {
    return NextResponse.json({ error: "发现配置不存在。" }, { status: 404 });
  }

  return NextResponse.json(profile);
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
