export interface CsvMessageRow {
  createdAt: Date;
  direction: string;
  itemType: string;
  text: string | null;
}

export function toCsv(rows: CsvMessageRow[]): string {
  const lines = ["created_at,direction,item_type,text"];
  for (const row of rows) {
    lines.push(
      [
        row.createdAt.toISOString(),
        row.direction,
        row.itemType,
        row.text ?? "",
      ]
        .map(escapeCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function escapeCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}
