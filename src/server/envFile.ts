import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const envFilePath = path.join(process.cwd(), ".env.local");

export type ProxyEnvEntry = {
  name: string;
  value: string;
  host?: string;
  port?: number;
  protocol?: string;
};

export async function listProxyEnvEntries(): Promise<ProxyEnvEntry[]> {
  const files = [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), ".env"),
  ];
  const values = new Map<string, string>();
  for (const file of files) {
    let content = "";
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim();
      if (!/^[A-Z0-9_]+$/.test(name) || !/(?:PROXY|SOCKS)/i.test(name))
        continue;
      const rawValue = line
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (rawValue) values.set(name, rawValue);
    }
  }
  return [...values.entries()].map(([name, value]) => {
    try {
      const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
        ? value
        : `http://${value}`;
      const parsed = new URL(normalized);
      return {
        name,
        value: normalized,
        protocol: parsed.protocol.replace(":", ""),
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
      };
    } catch {
      return { name, value };
    }
  });
}

export async function writeLocalEnvValue(key: string, value: string) {
  if (!/^[A-Z0-9_]+$/.test(key)) {
    throw new Error(
      "Environment variable name must use A-Z, 0-9, and underscore.",
    );
  }

  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return;
  }

  let content = "";
  try {
    content = await readFile(envFilePath, "utf8");
  } catch {
    content = "";
  }

  const lines = content.split(/\r?\n/);
  const nextLine = `${key}=${normalizedValue}`;
  let replaced = false;

  const updated = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return nextLine;
    }

    return line;
  });

  if (!replaced) {
    if (updated.length > 0 && updated[updated.length - 1] !== "") {
      updated.push("");
    }
    updated.push(nextLine);
  }

  await writeFile(
    envFilePath,
    updated.join("\n").replace(/\n*$/, "\n"),
    "utf8",
  );
  process.env[key] = normalizedValue;
}
