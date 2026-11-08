export function sanitizeReply(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^```[\w-]*\n?/gm, "")
    .replace(/```$/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .trim();
}

export function chunkReply(text: string, maxChars = 900, maxChunks = 3): string[] {
  const blocks = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let cur = "";

  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };

  for (const block of blocks) {
    if (block.length > maxChars) {
      push();
      for (const part of splitBySentence(block, maxChars)) chunks.push(part);
      continue;
    }
    if ((cur + "\n\n" + block).trim().length <= maxChars) {
      cur = cur ? `${cur}\n\n${block}` : block;
    } else {
      push();
      cur = block;
    }
  }
  push();

  if (chunks.length <= maxChunks) return chunks;
  const kept = chunks.slice(0, maxChunks);
  kept[maxChunks - 1] = `${kept[maxChunks - 1]!.slice(0, maxChars - 20)}\n…（内容较长，已省略）`;
  return kept;
}

function splitBySentence(text: string, max: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const sentence of text.split(/(?<=[。！？!?；;])/)) {
    if (cur.length + sentence.length <= max) {
      cur += sentence;
    } else {
      if (cur) parts.push(cur.trim());
      cur = sentence;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}
