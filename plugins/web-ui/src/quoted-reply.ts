// Quote-then-answer replies: an opening paragraph, then `> quoted point` blocks each followed by an answer.
export interface QuotedPoint {
  quote: string;
  answer: string;
}

export interface QuotedReply {
  intro: string;
  points: QuotedPoint[];
}

/** Split a markdown reply into its opening text and its `> quote` + answer pairs. */
export function parseQuotedReply(text: string): QuotedReply | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const intro: string[] = [];
  const points: { quote: string[]; answer: string[] }[] = [];
  let fence = false;
  let inQuote = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const quoted = !fence && /^\s{0,3}>/.test(line);
    if (quoted) {
      const body = line.replace(/^\s{0,3}>\s?/, "");
      if (!inQuote) points.push({ quote: [], answer: [] });
      points[points.length - 1]!.quote.push(body);
      inQuote = true;
      continue;
    }
    inQuote = false;
    if (points.length) points[points.length - 1]!.answer.push(line);
    else intro.push(line);
  }
  const parsed = points
    .map((p) => ({ quote: p.quote.join("\n").trim(), answer: p.answer.join("\n").trim() }))
    .filter((p) => p.quote && p.answer);
  if (parsed.length < 2) return null;
  return { intro: intro.join("\n").trim(), points: parsed };
}
