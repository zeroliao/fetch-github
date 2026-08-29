import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { requestViaProxy } from "@/server/aiClient";
import { listSingboxProxyNodes } from "@/server/singbox";

const payloadSchema = z.object({
  baseUrl: z.string().url(),
  timeoutSeconds: z.number().int().positive().max(30).optional(),
});

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  return NextResponse.json({ nodes: await listSingboxProxyNodes() });
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const parsed = payloadSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "请先填写有效的 Provider Base URL。",
        errors: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const nodes = await listSingboxProxyNodes();
  const target = new URL(parsed.data.baseUrl);
  target.pathname = "/";
  target.search = "";
  const timeoutMs = (parsed.data.timeoutSeconds ?? 10) * 1000;
  const results = await Promise.all(
    nodes.map(async (node) => {
      const startedAt = Date.now();
      try {
        const response = await requestViaProxy(
          target.toString(),
          { method: "GET" },
          node.address,
          timeoutMs,
        );
        return {
          ...node,
          connected: true,
          statusCode: response.status,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (cause) {
        return {
          ...node,
          connected: false,
          elapsedMs: Date.now() - startedAt,
          error: cause instanceof Error ? cause.message : "网络连接失败",
        };
      }
    }),
  );
  results.sort(
    (a, b) =>
      Number(!a.connected) - Number(!b.connected) ||
      a.elapsedMs - b.elapsedMs ||
      a.id.localeCompare(b.id),
  );
  return NextResponse.json({ baseUrl: parsed.data.baseUrl, results });
}
