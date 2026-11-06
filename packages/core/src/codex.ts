export function parseRepoAllowlist(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const alias = trimmed.slice(0, eq).trim();
    const path = trimmed.slice(eq + 1).trim();
    if (alias && path) map.set(alias, path);
  }
  return map;
}

export function parseUserAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
