import { z } from "zod";
import { requireAuth } from "@/server/auth";
import {
  exportMarkDirectory,
  exportMarkFile,
  MarkStoreError,
} from "@/server/markStore";

const querySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), id: z.string().uuid() }),
  z.object({ type: z.literal("directory"), id: z.string().uuid().nullable() }),
]);

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const rawId = url.searchParams.get("id");
  const parsed = querySchema.safeParse({ type, id: rawId || null });
  if (!parsed.success) {
    return Response.json({ error: "导出参数无效。" }, { status: 400 });
  }

  try {
    const result =
      parsed.data.type === "file"
        ? await exportMarkFile(auth.user.id, parsed.data.id)
        : await exportMarkDirectory(auth.user.id, parsed.data.id);
    const asciiName = result.name
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_");
    return new Response(new Uint8Array(result.data), {
      headers: {
        "Content-Type":
          parsed.data.type === "file"
            ? "text/plain; charset=utf-8"
            : "application/zip",
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof MarkStoreError) {
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "too_large"
            ? 413
            : 409;
      return Response.json({ error: error.message }, { status });
    }
    console.error("Mark export failed", error);
    return Response.json({ error: "导出失败，请稍后重试。" }, { status: 500 });
  }
}
