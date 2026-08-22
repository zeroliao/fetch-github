/** Uses the provider name as the single stable API key env name. */
export function providerNameToApiKeyEnv(name: string): string {
  const normalized = name
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toUpperCase();

  if (!normalized || !/^[A-Z_][A-Z0-9_]*$/.test(normalized)) {
    throw new Error("模型名称必须包含可用于 API Key 环境变量的字符。");
  }

  return normalized;
}
