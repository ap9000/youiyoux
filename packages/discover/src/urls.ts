import { isIP } from "node:net";

/** Literal-host check only; no DNS is performed while reading the directory. */
export function publicHttps(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (/^(localhost|.*\.localhost)$|\.(local|internal)$/.test(host)) return false;
    if (isIP(host) === 4) {
      const [a, b] = host.split(".").map(Number) as [number, number];
      return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
    }
    // IPv6 global unicast only: excludes loopback, mapped IPv4, ULA and link-local.
    if (isIP(host) === 6) return /^[23][0-9a-f]{3}:/.test(host);
    return host.includes(".");
  } catch { return false; }
}
