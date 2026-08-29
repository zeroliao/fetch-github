import { NextResponse } from "next/server";
import { MAX_AI_PROVIDER_MODELS } from "@/lib/types";
import { requireAuth } from "@/server/auth";
import {
  createProviderModelsXlsx,
  modelsForTransfer,
  parseProviderModelsJson,
  parseProviderModelsXlsx,
  type PortableProviderModel,
} from "@/server/providerModelTransfer";
import { listAiProviderGroups, updateAiProviderGroup } from "@/server/store";

type Params = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "模型文件处理失败。" },
    { status: 400 },
  );
}

export async function GET(request: Request, context: Params) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const group = (await listAiProviderGroups()).find((item) => item.id === id);
  if (!group)
    return NextResponse.json({ error: "Provider 不存在。" }, { status: 404 });
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  const models = modelsForTransfer(group.models);
  if (format === "xlsx") {
    return new NextResponse(createProviderModelsXlsx(models) as BodyInit, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="models.xlsx"; filename*=UTF-8''${encodeURIComponent(group.name + "-models.xlsx")}`,
      },
    });
  }
  if (format !== "json")
    return NextResponse.json(
      { error: "format 仅支持 json 或 xlsx。" },
      { status: 400 },
    );
  return new NextResponse(JSON.stringify({ version: 1, models }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="models.json"; filename*=UTF-8''${encodeURIComponent(group.name + "-models.json")}`,
    },
  });
}

export async function POST(request: Request, context: Params) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 2 * 1024 * 1024 + 64 * 1024)
    return NextResponse.json(
      { error: "导入请求超过大小限制。" },
      { status: 413 },
    );
  const { id } = await context.params;
  const group = (await listAiProviderGroups()).find((item) => item.id === id);
  if (!group)
    return NextResponse.json({ error: "Provider 不存在。" }, { status: 404 });
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      return NextResponse.json(
        { error: "请选择 JSON 或 XLSX 文件。" },
        { status: 400 },
      );
    if (file.size > 2 * 1024 * 1024)
      return NextResponse.json(
        { error: "导入文件超过 2 MB 限制。" },
        { status: 400 },
      );
    const name = file.name.toLowerCase();
    const bytes = Buffer.from(await file.arrayBuffer());
    const imported: PortableProviderModel[] = name.endsWith(".xlsx")
      ? parseProviderModelsXlsx(bytes)
      : name.endsWith(".json")
        ? parseProviderModelsJson(bytes.toString("utf8"))
        : (() => {
            throw new Error("仅支持 .json 或 .xlsx 文件。");
          })();
    const existing = new Set(
      group.models.map((model) => `${model.kind}:${model.model.toLowerCase()}`),
    );
    const additions = imported.filter(
      (model) => !existing.has(`${model.kind}:${model.model.toLowerCase()}`),
    );
    const existingModels = group.models.map((model) => ({
      ...modelsForTransfer([model])[0],
      id: model.id,
    }));
    const nextModels = [...existingModels, ...additions];
    if (nextModels.length > MAX_AI_PROVIDER_MODELS)
      throw new Error(`导入后模型总数不能超过 ${MAX_AI_PROVIDER_MODELS} 个。`);
    const updated = await updateAiProviderGroup(id, {
      name: group.name,
      type: group.type,
      baseUrl: group.baseUrl,
      apiKeyEnv: group.apiKeyEnv,
      proxyAddresses: group.proxyAddresses,
      enabled: group.enabled,
      models: nextModels,
    });
    if (!updated)
      return NextResponse.json({ error: "Provider 不存在。" }, { status: 404 });
    return NextResponse.json({
      group: updated,
      imported: additions.length,
      skipped: imported.length - additions.length,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
