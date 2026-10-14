import { inspect } from "node:util";

export function formatBrowserError(error, privateValues = []) {
  const secrets = new Set(privateValues.filter((value) => typeof value === "string" && value));
  for (const value of [...secrets]) {
    try {
      const url = new URL(value);
      for (const part of [url.href, `${url.origin}${url.pathname}`, url.hostname, url.password])
        if (part) secrets.add(part);
      if (url.password) {
        const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
        secrets.add(decodeURIComponent(url.password));
        secrets.add(credentials);
        secrets.add(Buffer.from(credentials).toString("base64"));
      }
    } catch {
      continue;
    }
  }
  let text = inspect(error, {
    depth: 8,
    maxArrayLength: 30,
    maxStringLength: 10_000,
    customInspect: false,
    getters: false,
  });
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, "<private browser value>");
  return text;
}
