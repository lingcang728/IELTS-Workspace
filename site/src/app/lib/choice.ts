/** Choose TWO/THREE：共享选项勾选顺序 ↔ 各题 value。 */

export function selectedLetters(
  questions: { id: string }[],
  values: Record<string, string | string[] | null | undefined>,
): string[] {
  const letters: string[] = [];
  for (const question of questions) {
    const value = values[question.id];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item !== "") letters.push(item);
      }
    } else if (typeof value === "string" && value !== "") {
      letters.push(value);
    }
  }
  return letters;
}

export function toggleSharedLetter(args: {
  questions: { id: string; number: number }[];
  values: Record<string, string | string[] | null | undefined>;
  letter: string;
  limit: number;
}): Record<string, string | null> {
  const ordered = [...args.questions].sort((a, b) => a.number - b.number);
  const selected = selectedLetters(ordered, args.values);
  const index = selected.indexOf(args.letter);
  let next: string[];
  if (index >= 0) {
    next = selected.filter((item) => item !== args.letter);
  } else if (selected.length < args.limit) {
    next = [...selected, args.letter];
  } else {
    next = selected;
  }
  const out: Record<string, string | null> = {};
  for (let i = 0; i < ordered.length; i++) {
    out[ordered[i].id] = next[i] ?? null;
  }
  return out;
}
