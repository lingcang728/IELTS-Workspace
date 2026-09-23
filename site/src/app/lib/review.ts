/**
 * Helpers shared by the review/study pages: answer formatting, source-excerpt
 * lookup (passage sentence for reading, transcript line for listening), the
 * vocab cloze, the "练这个题型" library link, and a clipboard write with a
 * non-secure-context fallback.
 */
import type { Exam, Mistake, Transcript, TranscriptLine, VocabSighting } from "../types";
import { sectionForQuestion } from "../types";
import { sentenceContaining } from "./mistakes";
import { href } from "../nav";

/** Display form of a stored answer value. */
export function answerText(value: Mistake["userAnswer"] | unknown): string {
  if (value == null || value === "") return "（未作答）";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** The sighting sentence with the term blanked out — the front of the card. */
export function cloze(sighting: VocabSighting | undefined, term: string): string {
  const sentence = sighting?.sentence ?? "";
  if (!sentence) return "";
  if (typeof sighting?.start === "number" && typeof sighting?.end === "number"
      && sighting.end > sighting.start && sighting.end <= sentence.length) {
    return `${sentence.slice(0, sighting.start)}______${sentence.slice(sighting.end)}`;
  }
  // Fall back to a case-insensitive whole-word replacement; if the term is not
  // literally in the sentence (an inflected form), show the sentence as it is
  // rather than a wrong blank.
  const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  return pattern.test(sentence) ? sentence.replace(pattern, "______") : sentence;
}

/** `TranscriptLine.answers` is `number[] | string` — normalise to numbers. */
export function transcriptAnswers(line: TranscriptLine): number[] {
  if (Array.isArray(line.answers)) return line.answers;
  return [...String(line.answers ?? "").matchAll(/\d+/g)].map((m) => Number(m[0]));
}

function transcriptLineText(line: TranscriptLine): string {
  return `${line.speaker ? `${line.speaker}: ` : ""}${line.text}`.trim();
}

interface ExcerptRow {
  questionId: string;
  number: number;
  acceptedAnswers: string[];
}

/**
 * Where the answer lives in the source material. Reading searches the section
 * passage for the sentence containing an accepted answer; listening looks up
 * the transcript line marked as carrying that question number, falling back
 * to a sentence search over the lines. Returns undefined when nothing can be
 * located — the caller then just omits the blockquote.
 */
export function sourceExcerptFor(exam: Exam, transcript: Transcript | null, row: ExcerptRow): string | undefined {
  const section = sectionForQuestion(exam, row.questionId);
  if (!section) return undefined;

  if (exam.module === "listening") {
    const tsec = transcript?.sections.find((s) => s.sectionId === section.id);
    const lines = tsec?.lines ?? [];
    if (lines.length) {
      const carrying = lines.filter((line) => transcriptAnswers(line).includes(row.number));
      if (carrying.length) {
        const text = [...new Set(carrying.map(transcriptLineText))].filter(Boolean).join(" / ");
        if (text) return text;
      }
      for (const answer of row.acceptedAnswers) {
        for (const line of lines) {
          const hit = sentenceContaining(line.text, answer);
          if (hit) return `${line.speaker ? `${line.speaker}: ` : ""}${hit}`;
        }
      }
    }
    return undefined;
  }

  const text = section.content?.text ?? "";
  if (!text) return undefined;
  return row.acceptedAnswers.map((answer) => sentenceContaining(text, answer)).find(Boolean);
}

/** Where "练这个题型" goes — the library filters on this query key. */
export function practiceTypeHref(questionType: string): string {
  return href("/app/library", { type: questionType });
}

/**
 * Clipboard write that also works off secure contexts (plain http preview),
 * where `navigator.clipboard` is absent.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("execCommand copy 被拒绝");
  } finally {
    document.body.removeChild(area);
  }
}
