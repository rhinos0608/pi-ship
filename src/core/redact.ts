import { environmentSource } from "./environment.js";

export function redact(text: string, envNames: string[], secretValues: string[] = []): string {
  const secrets: string[] = secretValues.filter((value) => value.length > 0);
  const source = environmentSource();
  for (const name of envNames) {
    const value = source.get(name);
    if (value && value.length >= 6) {
      secrets.push(value);
    }
  }
  // Catch URL passwords (postgres://user:password@host/...)
  const urlPasswordPattern = /\/\/[^:@\s]+:([^@\s/]+)@/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = urlPasswordPattern.exec(text)) !== null) {
    if (m[1].length >= 6) secrets.push(m[1]);
  }
  // Bearer / token patterns
  const bearerPattern = /(?:Bearer|token|api[_-]?key)[:\s]+([A-Za-z0-9_\-\.]{16,})/gi;
  while ((m = bearerPattern.exec(text)) !== null) {
    secrets.push(m[1]);
  }
  // 32+ char hex or base64 runs
  const longTokenPattern = /\b([A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{43,}={0,2})\b/g;
  while ((m = longTokenPattern.exec(text)) !== null) {
    secrets.push(m[0]);
  }
  let out = text;
  // Sort by length desc so longer secrets replace first
  const unique = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  for (const secret of unique) {
    if (seen.has(secret)) continue;
    seen.add(secret);
    const safe = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(safe, "g"), "***");
  }
  return out;
}
