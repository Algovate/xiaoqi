import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export interface OutboundFile {
  path: string;
  mime: string;
  filename: string;
  size?: number;
}

export async function writeOutboundFile(
  outputDir: string,
  prefix: string,
  data: Buffer,
  ext: string,
  mime: string,
  maxBytes: number,
): Promise<OutboundFile> {
  if (data.length > maxBytes) throw new Error(`${prefix} file too large: ${data.length} bytes`);

  await fsp.mkdir(outputDir, { recursive: true });
  const filename = `${prefix}-${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(outputDir, filename);
  await fsp.writeFile(filePath, data, { mode: 0o600 });
  return { path: filePath, mime, filename, size: data.length };
}
