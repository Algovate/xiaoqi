import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const CODE_FENCE = /```([\w+-]*)\n([\s\S]*?)```/g;

export interface CodeBlock {
  language: string;
  code: string;
}

export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const match of text.matchAll(CODE_FENCE)) {
    const code = match[2]?.trimEnd() ?? "";
    if (code.trim()) blocks.push({ language: (match[1] ?? "").toLowerCase(), code });
  }
  return blocks;
}

export function removeCodeBlocks(text: string): string {
  return text
    .replace(CODE_FENCE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function writeCodeFile(
  blocks: CodeBlock[],
  outputDir: string,
  maxBytes: number,
): Promise<{ path: string; mime: string; filename: string }> {
  const ext = extensionFor(blocks);
  const body =
    blocks.length === 1
      ? `${blocks[0]!.code}\n`
      : `${blocks
          .map((block, index) => `# ===== block ${index + 1}: ${block.language || "text"} =====\n${block.code}`)
          .join("\n\n")}\n`;
  const data = Buffer.from(body, "utf8");
  if (data.length > maxBytes) throw new Error(`code file too large: ${data.length} bytes`);

  await fsp.mkdir(outputDir, { recursive: true });
  const filename = `xiaoqi-code-${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(outputDir, filename);
  await fsp.writeFile(filePath, data, { mode: 0o600 });
  return { path: filePath, mime: mimeFor(ext), filename };
}

function extensionFor(blocks: CodeBlock[]): string {
  const languages = new Set(blocks.map((block) => block.language).filter(Boolean));
  if (languages.size !== 1) return "txt";
  const language = [...languages][0]!;
  const map: Record<string, string> = {
    python: "py",
    py: "py",
    javascript: "js",
    js: "js",
    typescript: "ts",
    ts: "ts",
    bash: "sh",
    sh: "sh",
    shell: "sh",
    json: "json",
    sql: "sql",
    html: "html",
    css: "css",
    yaml: "yaml",
    yml: "yaml",
    go: "go",
    rust: "rs",
    java: "java",
    c: "c",
    cpp: "cpp",
  };
  return map[language] ?? "txt";
}

function mimeFor(ext: string): string {
  switch (ext) {
    case "py": return "text/x-python";
    case "js": return "application/javascript";
    case "ts": return "text/typescript";
    case "json": return "application/json";
    case "html": return "text/html";
    case "css": return "text/css";
    case "sql": return "text/plain";
    default: return "text/plain";
  }
}
