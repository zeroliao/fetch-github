import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const defaultEnvFiles = [".env.local", ".env"];

export function loadLocalEnv(cwd = process.cwd(), options = {}) {
  for (const fileName of defaultEnvFiles) {
    const filePath = path.join(cwd, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    const content = readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separator = line.indexOf("=");
      if (separator <= 0) {
        continue;
      }

      const key = line.slice(0, separator).trim();
      if (!/^[A-Z0-9_]+$/.test(key)) {
        continue;
      }

      const currentValue = process.env[key];
      if (currentValue !== undefined && (currentValue !== "" || !options.overrideEmpty)) {
        continue;
      }

      process.env[key] = normalizeEnvValue(line.slice(separator + 1).trim());
    }
  }
}

function normalizeEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
