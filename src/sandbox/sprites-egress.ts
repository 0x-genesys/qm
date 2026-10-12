export function spritesEgressHosts(primary?: string, additional: string[] = []): string[] {
  if (!primary && additional.length)
    throw new Error("sprites additional egress proxy URLs require a primary proxy URL");
  if (!primary) return [];
  return [
    ...new Set(
      [primary, ...additional].map((value) => {
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password)
          throw new Error("sprites egress proxy URLs must be HTTP(S) URLs without credentials");
        return url.hostname.toLowerCase().replace(/\.$/, "");
      }),
    ),
  ].sort();
}
