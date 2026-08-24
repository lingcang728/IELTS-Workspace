export type ModuleKind = "reading" | "listening" | "writing" | "speaking";
export type ExamMode = "mock" | "practice";
export type SessionStatus =
  | "created"
  | "in_progress"
  | "submitted"
  | "aborted"
  | "interrupted";
export type Integrity = "clean" | "interrupted";

export type QuestionType =
  | "single_choice"
  | "multi_choice"
  | "true_false_ng"
  | "yes_no_ng"
  | "completion"
  | "matching"
  | "labelling";

export type ScoringPolicy = "per_question" | "in_either_order";

export type EndCondition =
  | { type: "fixed_duration"; durationMs: number }
  | { type: "media_driven"; checkMsAfterEnd: number };

export interface ExamPolicy {
  modeDefault?: ExamMode;
  pauseAllowed: boolean;
  answerVisible: boolean;
  aiAllowed: boolean;
  forceSubmit: boolean;
  audioSeekAllowed: boolean;
  strictNavigation: boolean;
  endCondition: EndCondition;
  timeWarningsMs: number[];
}

export interface SourceMeta {
  kind: "official_sample" | "cambridge_book" | "imported_document" | "generated_practice";
  publisher?: string;
  title?: string;
  url?: string;
  accessed?: string;
  note?: string;
  /** Evidence trail for local PDFs, MinerU runs, and answer-key cross-checks. */
  provenance?: SourceProvenance[];
}

export interface SourceProvenance {
  kind: "pdf" | "mineru" | "answer_key" | "audio" | "external";
  source: string;
  url?: string;
  sha256?: string;
  accessed?: string;
  note?: string;
}

export interface ChoiceOption {
  id: string;
  label: string;
  text: string;
}

export interface Question {
  id: string;
  number: number;
  type: QuestionType;
  prompt: string;
  gapText?: string;
  options?: ChoiceOption[];
  acceptedAnswers?: string[];
  wordLimit?: number;
  imageAsset?: string;
}

export interface QuestionGroup {
  id: string;
  instruction: string;
  questionType: QuestionType;
  scoringPolicy: ScoringPolicy;
  sharedOptions?: ChoiceOption[];
  wordBank?: string[];
  acceptedAnswers?: string[];
  wordLimit?: number;
  imageAsset?: string;
  /** Sanitized table/list/flow layout with {{q:question-id}} placeholders. */
  layoutHtml?: string;
  questions: Question[];
}

export interface ExamSection {
  id: string;
  title: string;
  kind: "passage" | "listening_part" | "writing_task";
  content?: { format: "plain" | "html"; text: string };
  audioAsset?: string;
  imageAsset?: string;
  questionGroups: QuestionGroup[];
}

export interface Exam {
  schemaVersion: 1;
  id: string;
  title: string;
  module: ModuleKind;
  source: SourceMeta;
  policy: ExamPolicy;
  sections: ExamSection[];
  /** Changes when MinerU correction or an answer-key repair invalidates resume. */
  contentRevision?: string;
}

export interface AnswerEntry {
  questionId: string;
  questionType: QuestionType;
  value: string | string[] | null;
  flagged: boolean;
  updatedAt: string;
}

export interface HighlightRecord {
  id: string;
  targetId: string;
  startOffset: number;
  endOffset: number;
  offsetUnit: "unicode_code_point";
  textHash: string;
  contextBefore: string;
  contextAfter: string;
  excerpt: string;
  invalid?: boolean;
}

export interface NoteRecord {
  id: string;
  attach: "highlight" | "passage" | "question";
  targetId: string;
  highlightId?: string;
  body: string;
  updatedAt: string;
}

export interface SessionEvent {
  t: string;
  type:
    | "nav"
    | "submit"
    | "start"
    | "pause"
    | "resume"
    | "warn"
    | "audio_end"
    | "force_submit"
    | "autosave"
    | "highlight"
    | "note";
  questionId?: string;
  sectionId?: string;
  extra?: string;
}

export interface Session {
  schemaVersion: 1;
  id: string;
  examId: string;
  /** Optional for legacy sessions; mismatches are interrupted on resume. */
  examRevision?: string;
  examTitle: string;
  module: ModuleKind;
  mode: ExamMode;
  status: SessionStatus;
  integrity: Integrity;
  startedAt: string;
  updatedAt: string;
  remainingMs: number;
  answers: Record<string, AnswerEntry>;
  highlights: HighlightRecord[];
  notes: NoteRecord[];
  events: SessionEvent[];
  audio?: { positionMs: number; partIndex: number; ended?: boolean };
  writing?: Record<string, string>;
  fontScale?: number;
  colorScheme?: "default" | "high_contrast" | "cream";
  saveError?: string | null;
}

export interface ScoreReport {
  schemaVersion: number;
  examId: string;
  rawCorrect: number;
  rawTotal: number;
  questions: {
    questionId: string;
    number: number;
    questionType: string;
    correct: boolean;
    userAnswer: unknown;
    acceptedAnswers: string[];
  }[];
}

export interface AnalyticsPoint {
  date: string;
  module?: ModuleKind;
  /** Estimated band from schema/band-conversion.json; null below the table. */
  band?: number | null;
  rawCorrect?: number;
  rawTotal?: number;
  durationMs?: number;
}

export interface AnalyticsReport {
  schemaVersion: 1;
  generatedAt: string;
  rangeDays: number;
  overallAverage?: number;
  moduleAverages: Partial<Record<ModuleKind, number>>;
  moduleCounts: Partial<Record<ModuleKind, number>>;
  /** Submitted sessions whose raw score falls below the band table. */
  unbandedCounts: Partial<Record<ModuleKind, number>>;
  scoreTrend: Partial<Record<ModuleKind, AnalyticsPoint[]>>;
  questionTypeAccuracy: { module: "reading" | "listening"; questionType: string; correct: number; total: number; accuracy: number }[];
  timeTrend: AnalyticsPoint[];
  speakingEnabled: false;
}

export interface ExamSummary {
  id: string;
  title: string;
  module: ModuleKind;
  source: SourceMeta;
  path: string;
  durationMs?: number;
  questionCount: number;
}

export interface SessionSummary {
  id: string;
  examId: string;
  module: ModuleKind;
  mode: ExamMode;
  status: SessionStatus;
  integrity: Integrity;
  startedAt: string;
  updatedAt: string;
  title?: string;
}

export interface ProbeResult {
  ok: boolean;
  dataRoot: string;
  appRoot: string;
  dev: boolean;
  warning?: string | null;
  error?: string | null;
}

export interface Profile {
  theme?: "light" | "dark";
  /** Target overall band, 4.0-9.0 in 0.5 steps. Drives "距目标还差 N 题". */
  targetBand?: number;
  /** Exam date as YYYY-MM-DD. Drives the countdown on the workbench. */
  examDate?: string;
}

export interface Bootstrap {
  probe: ProbeResult;
  exams: ExamSummary[];
  sessions: SessionSummary[];
  profile: Profile | null;
}

export function allQuestions(exam: Exam): Question[] {
  return exam.sections.flatMap((s) => s.questionGroups.flatMap((g) => g.questions));
}

export function groupForQuestion(exam: Exam, questionId: string): QuestionGroup | undefined {
  for (const s of exam.sections) {
    for (const g of s.questionGroups) {
      if (g.questions.some((q) => q.id === questionId)) return g;
    }
  }
  return undefined;
}

export function sectionForQuestion(exam: Exam, questionId: string): ExamSection | undefined {
  for (const s of exam.sections) {
    if (s.questionGroups.some((g) => g.questions.some((q) => q.id === questionId))) return s;
  }
  return undefined;
}
