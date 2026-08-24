/**
 * Prompt templates for the Prompt Studio.
 *
 * This app has no built-in AI on purpose: no key, no network, no telemetry.
 * What it does instead is assemble everything an external model would need —
 * the task, the learner's answer, the accepted answers, the source sentence —
 * so the reply comes back grounded instead of hallucinated. Every template
 * therefore carries the material inline; none of them says "the passage above"
 * without including it.
 */
import type { Mistake, PromptTemplate, Transcript, VocabCard } from "./types";

const RULES = [
  "请用简体中文回复。",
  "任何分数或 band 必须标注 Estimated，不是官方成绩。",
  "不要编造原文里没有的内容；材料以下面给出的为准。",
].join("\n");

export interface TemplateMeta {
  id: PromptTemplate;
  label: string;
  blurb: string;
}

export const TEMPLATES: TemplateMeta[] = [
  { id: "writing", label: "作文批改", blurb: "四项评分维度 + 可直接改的句子" },
  { id: "explain", label: "逐题讲解", blurb: "错题 + 原文出处 + 可接受答案" },
  { id: "speaking", label: "口语陪练", blurb: "Part 1/2/3 题目 + 角色设定 + 追问" },
  { id: "listening", label: "精听复盘", blurb: "听错的题 + 对应原文片段" },
];

export function writingPrompt(taskTitle: string, taskPrompt: string, essay: string): string {
  const count = essay.trim() ? essay.trim().split(/\s+/).length : 0;
  return [
    "你是 IELTS Academic 写作考官。",
    RULES,
    "",
    "按 Task Response / Coherence and Cohesion / Lexical Resource / Grammatical Range and Accuracy",
    "四项分别给 Estimated band 区间与理由，然后挑 5 处最值得改的句子给出改写。",
    "",
    `## ${taskTitle}`,
    taskPrompt.trim(),
    "",
    "## 考生作文",
    essay.trim() || "(空)",
    `字数: ${count}`,
  ].join("\n");
}

export function explainPrompt(mistakes: Mistake[]): string {
  const lines = [
    "你是 IELTS 辅导老师，请逐题讲解下面这些做错的题。",
    RULES,
    "",
    "每题请说明：正确答案为什么对、我的答案为什么错、这一类题下次该怎么定位。",
    "",
  ];
  for (const item of mistakes) {
    lines.push(
      `## Q${item.number} · ${item.examTitle || item.examId} · ${item.questionType}`,
      `题目: ${item.prompt || "(题面缺失)"}`,
      `我的答案: ${formatAnswer(item.userAnswer)}`,
      `可接受答案: ${item.acceptedAnswers.join(" / ") || "(无)"}`,
    );
    if (item.sourceExcerpt) lines.push(`原文出处: ${item.sourceExcerpt}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function speakingPrompt(topic: string, part: 1 | 2 | 3): string {
  const role = {
    1: "Part 1：就日常话题问 4-6 个简短问题，一次一个，等我回答后再问下一个。",
    2: "Part 2：给我一张 cue card，让我准备 1 分钟、说 1-2 分钟，结束后追问 1-2 个问题。",
    3: "Part 3：就该话题做抽象讨论，追问理由和对比，一次一个问题。",
  }[part];
  return [
    "你是 IELTS 口语考官。全程英文提问，我用英文回答。",
    "每轮我回答后，先用中文给一句反馈（流利度/词汇/语法各挑一点），再问下一题。",
    "不要一次抛出所有问题。",
    "",
    role,
    "",
    `话题: ${topic}`,
  ].join("\n");
}

export function listeningPrompt(
  examTitle: string,
  mistakes: Mistake[],
  transcript: Transcript | null,
): string {
  const lines = [
    "你是 IELTS 听力辅导老师。下面是我听错的题和对应的原文句子。",
    RULES,
    "",
    "请指出每题的答案信号词出现在原文哪个位置，以及我可能是被什么干扰了。",
    "",
    `试卷: ${examTitle}`,
    "",
  ];
  const wanted = new Set(mistakes.map((m) => m.number));
  const carrying: string[] = [];
  for (const section of transcript?.sections ?? []) {
    for (const line of section.lines) {
      const answers = Array.isArray(line.answers)
        ? line.answers
        : [...String(line.answers ?? "").matchAll(/\d+/g)].map((m) => Number(m[0]));
      if (answers.some((n) => wanted.has(n))) {
        carrying.push(`Q${answers.join("/Q")}: ${line.speaker ? `${line.speaker}: ` : ""}${line.text}`);
      }
    }
  }
  for (const item of mistakes) {
    lines.push(
      `## Q${item.number} (${item.questionType})`,
      `题目: ${item.prompt || "(题面缺失)"}`,
      `我的答案: ${formatAnswer(item.userAnswer)}`,
      `正确答案: ${item.acceptedAnswers.join(" / ") || "(无)"}`,
      "",
    );
  }
  if (carrying.length) {
    lines.push("## 原文中承载答案的句子", ...carrying, "");
  } else {
    lines.push("（这套题还没有提取到听力原文，请只根据题目和答案讲解。）", "");
  }
  return lines.join("\n");
}

export function vocabPrompt(cards: VocabCard[]): string {
  return [
    "下面是我在真题里遇到的生词，每个都带原句。",
    RULES,
    "",
    "请为每个词给出：这句话里的含义、一个同义替换、以及一个雅思写作里能用的例句。",
    "",
    ...cards.map((card) => {
      const sentence = card.sightings?.[0]?.sentence ?? "";
      return `- ${card.term}${sentence ? `  ——  ${sentence}` : ""}`;
    }),
  ].join("\n");
}

function formatAnswer(value: Mistake["userAnswer"]): string {
  if (value == null || value === "") return "(未作答)";
  return Array.isArray(value) ? value.join(", ") : String(value);
}
