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
