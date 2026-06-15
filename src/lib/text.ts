export interface TextChunk {
  index: number;
  text: string;
}

export function chunkText(text: string, chunkSizeChars = 8000): TextChunk[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const chunks: TextChunk[] = [];
  for (let offset = 0; offset < normalized.length; offset += chunkSizeChars) {
    chunks.push({
      index: chunks.length,
      text: normalized.slice(offset, offset + chunkSizeChars)
    });
  }

  return chunks;
}

export function compactMarkdownForAnalysis(text: string, maxChars = 12000) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const selected: string[] = [];
  let inFence = false;
  let fenceLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      fenceLines = 0;
      selected.push(line);
      continue;
    }

    if (inFence) {
      if (fenceLines < 8) {
        selected.push(line);
        fenceLines += 1;
      }
      continue;
    }

    if (
      trimmed.startsWith("#") ||
      /^[-*]\s+/.test(trimmed) ||
      /^\d+\.\s+/.test(trimmed) ||
      /install|usage|feature|quickstart|deploy|docker|api|sdk|pricing|license|roadmap|example|self-host/i.test(
        trimmed
      )
    ) {
      selected.push(line);
    }
  }

  const compacted = selected.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (compacted.length >= Math.floor(maxChars * 0.35)) {
    return compacted.slice(0, maxChars);
  }

  const headLimit = Math.max(0, Math.floor((maxChars - compacted.length) * 0.65));
  const tailLimit = Math.max(0, maxChars - compacted.length - headLimit - 80);
  const sections = [
    normalized.slice(0, headLimit),
    compacted,
    "[... README 中间部分已省略，保留开头、结尾和结构化信号用于分析 ...]",
    normalized.slice(-tailLimit)
  ].filter(Boolean);

  return sections.join("\n\n").slice(0, maxChars);
}
