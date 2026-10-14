/**
 * Subsequence fuzzy match for file paths. Higher scores are better; null means no match.
 * Consecutive characters, word starts and matches in the file name score higher.
 */
export const fuzzyScore = (query: string, target: string): number | null => {
  const q = query.toLowerCase().replace(/\s+/g, "");

  if (q.length === 0) return 0;
  const t = target.toLowerCase();
  const nameStart = target.lastIndexOf("/") + 1;
  let score = 0;
  let ti = 0;
  let prev = -2;

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let found = -1;

    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }

      ti++;
    }

    if (found < 0) return null;
    let s = 1;

    if (found === prev + 1) s += 4;
    const before = found > 0 ? target[found - 1]! : "/";

    if (before === "/" || before === "-" || before === "_" || before === "." || before === " ") s += 3;

    if (found >= nameStart) s += 2;
    score += s;
    prev = found;
    ti = found + 1;
  }

  // Prefer shorter paths when scores tie.
  return score - target.length * 0.01;
};

export const fuzzyFilter = <T>(
  query: string,
  items: ReadonlyArray<T>,
  key: (item: T) => string,
  limit = 50,
): T[] => {
  if (query.trim() === "") return items.slice(0, limit);
  const scored: Array<{ item: T; score: number }> = [];

  for (const item of items) {
    const score = fuzzyScore(query, key(item));

    if (score !== null) scored.push({ item, score });
  }

  scored.sort((x, y) => y.score - x.score);

  return scored.slice(0, limit).map((x) => x.item);
};
