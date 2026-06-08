import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const envFilePath = path.join(process.cwd(), ".env.local");

export async function writeLocalEnvValue(key: string, value: string) {
  if (!/^[A-Z0-9_]+$/.test(key)) {
    throw new Error("Environment variable name must use A-Z, 0-9, and underscore.");
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

  await writeFile(envFilePath, updated.join("\n").replace(/\n*$/, "\n"), "utf8");
  process.env[key] = normalizedValue;
}
