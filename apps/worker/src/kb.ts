import fsp from "node:fs/promises";
import path from "node:path";
import type { Database } from "@xiaoqi/core";
import { kbChunks, kbDocuments } from "@xiaoqi/core";
import type { Pool } from "pg";

const SUPPORTED = new Set([".pdf", ".docx", ".txt", ".md"]);

export interface KbHit {
  title: string;
  content: string;
  hits: number;
}

export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().normalize("NFKC");
  const tokens = new Set<string>();

  for (const word of normalized.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word);

  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }

  return [...tokens].slice(0, 300);
}

export async function ingestPath(db: Database, target: string): Promise<string[]> {
  const files = await collectFiles(target);
  const done: string[] = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED.has(ext)) continue;
    const buf = await fsp.readFile(file);
    let text = "";
    if (ext === ".pdf") {
      const { extractText } = await import("unpdf");
      const result = await extractText(new Uint8Array(buf), { mergePages: true });
      text = String(result.text);
    } else if (ext === ".docx") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result.value;
    } else {
      text = buf.toString("utf8");
    }
    text = text.trim();
    if (!text) continue;

    const title = path.basename(file);
    const docRows = await db
      .insert(kbDocuments)
      .values({ title, sourcePath: file, status: "ready" })
      .returning({ id: kbDocuments.id });
    const documentId = docRows[0]!.id;

    const chunks = chunkText(text, 1200, 100);
    for (let i = 0; i < chunks.length; i += 1) {
      await db.insert(kbChunks).values({
        documentId,
        chunkIndex: i,
        content: chunks[i]!,
        tokens: tokenize(chunks[i]!),
      });
    }
    done.push(`${title} (${chunks.length} chunks)`);
  }

  return done;
}

export async function searchKnowledge(
  pool: Pool,
  query: string,
  limit = 5,
): Promise<KbHit[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  try {
    const result = await pool.query<KbHit>(
      `
        select d.title, c.content,
          cardinality(array(
            select unnest(c.tokens)
            intersect
            select unnest($1::text[])
          )) as hits
        from kb_chunks c
        join kb_documents d on d.id = c.document_id
        where c.tokens && $1::text[]
        order by hits desc, c.id
        limit $2
      `,
      [tokens, limit],
    );
    return result.rows.filter((r) => Number(r.hits) > 0);
  } catch {
    return [];
  }
}

export function chunkText(text: string, max = 1200, overlap = 100): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  if (normalized.length <= max) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + max, normalized.length);
    if (end < normalized.length) {
      const breakAt = Math.max(
        normalized.lastIndexOf("\n", end),
        normalized.lastIndexOf("。", end),
        normalized.lastIndexOf("！", end),
        normalized.lastIndexOf("？", end),
      );
      if (breakAt > start + max * 0.5) end = breakAt + 1;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

async function collectFiles(target: string): Promise<string[]> {
  const stat = await fsp.stat(target);
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (SUPPORTED.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}
