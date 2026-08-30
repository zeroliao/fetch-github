import { readFile } from "node:fs/promises";
import path from "node:path";

export type SingboxProxyNode = {
  id: string;
  name: string;
  address: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
};

function configCandidates() {
  return [
    process.env.SINGBOX_CONFIG_PATH,
    "/etc/sing-box/config.json",
    "/etc/sing-box/config.jsonc",
    path.join(process.cwd(), "sing-box", "config.json"),
    path.join(process.cwd(), "config", "sing-box.json"),
  ].filter((value): value is string => Boolean(value));
}

function normalizeListenHost(value: unknown): string {
  const host = String(value ?? "127.0.0.1").trim();
  if (!host || host === "0.0.0.0" || host === "::" || host === "*") {
    return "127.0.0.1";
  }
  return host;
}

function stripJsonc(content: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") index++;
      output += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      )
        index++;
      index++;
      output += " ";
    } else output += char;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function parseConfig(content: string): unknown {
  try {
    return JSON.parse(stripJsonc(content));
  } catch {
    return undefined;
  }
}

function protocolFor(type: unknown): SingboxProxyNode["protocol"] | undefined {
  if (type === "socks" || type === "mixed") return "socks5";
  if (type === "http") return "http";
  return undefined;
}

export function parseSingboxProxyNodes(content: string): SingboxProxyNode[] {
  const nodes = new Map<string, SingboxProxyNode>();
  const config = parseConfig(content);
  const inbounds =
    config &&
    typeof config === "object" &&
    Array.isArray((config as any).inbounds)
      ? (config as any).inbounds
      : [];
  for (const inbound of inbounds) {
    if (!inbound || typeof inbound !== "object") continue;
    const protocol = protocolFor((inbound as any).type);
    const port = Number((inbound as any).listen_port);
    if (!protocol || !Number.isInteger(port) || port <= 0 || port > 65535)
      continue;
    const rawHost = normalizeListenHost((inbound as any).listen);
    const host =
      rawHost.includes(":") && !rawHost.startsWith("[")
        ? `[${rawHost}]`
        : rawHost;
    const address = `${protocol}://${host}:${port}`;
    const id = `${protocol}:${host}:${port}`;
    nodes.set(id, {
      id,
      name: String((inbound as any).tag || id),
      address,
      protocol,
      host,
      port,
    });
  }
  return [...nodes.values()].sort(
    (a, b) => a.port - b.port || a.id.localeCompare(b.id),
  );
}

export async function listSingboxProxyNodes(): Promise<SingboxProxyNode[]> {
  const nodes = new Map<string, SingboxProxyNode>();
  for (const file of configCandidates()) {
    try {
      for (const node of parseSingboxProxyNodes(await readFile(file, "utf8")))
        nodes.set(node.id, node);
    } catch {
      // A missing or unreadable candidate should not prevent other locations
      // from being inspected.
    }
  }
  return [...nodes.values()].sort(
    (a, b) => a.port - b.port || a.id.localeCompare(b.id),
  );
}
