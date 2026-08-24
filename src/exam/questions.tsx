import { useState, type ReactNode } from "react";
import type { ExamMode, ExamSection, Question, QuestionGroup } from "../lib/types";

interface Props {
  group: QuestionGroup;
  section: ExamSection;
  values: Record<string, string | string[] | null | undefined>;
  onChange: (questionId: string, value: string | string[] | null) => void;
  disabled?: boolean;
  skin?: ExamMode;
  /**
   * False when the group above this one printed the same rubric. The importer
   * split many printed groups into one group per question, so without this the
   * exam sheet repeats "Do the following statements agree ..." forty times.
   */
  showInstruction?: boolean;
}

export function QuestionGroupView({ group, values, onChange, disabled, skin = "mock", showInstruction = true }: Props) {
  const practice = skin === "practice";
  const layoutQuestionIds = group.layoutHtml
    ? new Set(
        [...group.layoutHtml.matchAll(/\{\{\s*q\s*:\s*([^}]+?)\s*\}\}/g)].map((match) =>
          match[1].trim(),
        ),
      )
    : new Set<string>();
  if (practice && group.questionType === "matching") {
    return (
      <MatchingBoard group={group} values={values} onChange={onChange} disabled={disabled}
                     showInstruction={showInstruction} />
    );
  }
  return (
    <section className={`q-group ${practice ? "q-group-practice" : ""}`}>
      {showInstruction && (
        <div className="instr" dangerouslySetInnerHTML={{ __html: escapeKeepBreaks(group.instruction) }} />
      )}
      {group.wordBank && group.wordBank.length > 0 && (
        <p className="bank">{group.wordBank.join(" · ")}</p>
      )}
      {group.layoutHtml ? (
        <QuestionLayout
          html={group.layoutHtml}
          group={group}
          values={values}
          onChange={onChange}
          disabled={disabled}
        />
      ) : null}
      {group.questions.filter((q) => !layoutQuestionIds.has(q.id)).map((q) => (
        <QuestionView
          key={q.id}
          question={q}
          group={group}
          value={values[q.id] ?? null}
          onChange={onChange}
          disabled={disabled}
          practice={practice}
        />
      ))}
    </section>
  );
}

/**
 * Render MinerU table/list/flow layouts without injecting untrusted markup.
 * The builder may persist a layout, but the runtime still applies the same
 * allow-list before creating React nodes and controlled question inputs.
 */
function QuestionLayout({
  html,
  group,
  values,
  onChange,
  disabled,
}: {
  html: string;
  group: QuestionGroup;
  values: Record<string, string | string[] | null | undefined>;
  onChange: (questionId: string, value: string | string[] | null) => void;
  disabled?: boolean;
}) {
  const source = sanitizeLayoutHtml(html);
  if (!source) return null;
  const nodes = typeof document === "undefined" ? [] : Array.from(new DOMParser().parseFromString(source, "text/html").body.childNodes);
  return (
    <div className="q-layout" aria-label="Question layout">
      {nodes.map((node, index) => renderLayoutNode(node, `${group.id}-${index}`, group, values, onChange, disabled))}
    </div>
  );
}

const LAYOUT_TAGS = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "ul",
  "ol",
  "li",
  "p",
  "div",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "br",
  "hr",
]);

const LAYOUT_ATTRS = new Set(["colspan", "rowspan", "scope", "class"]);

function sanitizeLayoutHtml(raw: string): string {
  if (!raw.trim() || typeof document === "undefined") return "";
  const parsed = new DOMParser().parseFromString(raw, "text/html");
  const visit = (element: Element) => {
    for (const child of Array.from(element.children)) {
      const tag = child.tagName.toLowerCase();
      if (!LAYOUT_TAGS.has(tag)) {
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (!LAYOUT_ATTRS.has(name) || name.startsWith("on") || /(?:javascript|data|vbscript):/i.test(attr.value)) {
          child.removeAttribute(attr.name);
        }
      }
      visit(child);
    }
  };
  visit(parsed.body);
  return parsed.body.innerHTML;
}

function renderLayoutNode(
  node: ChildNode,
  key: string,
  group: QuestionGroup,
  values: Record<string, string | string[] | null | undefined>,
  onChange: (questionId: string, value: string | string[] | null) => void,
  disabled?: boolean,
): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return renderLayoutText(node.textContent || "", key, group, values, onChange, disabled);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const children = Array.from(element.childNodes).map((child, index) =>
    renderLayoutNode(child, `${key}-${index}`, group, values, onChange, disabled),
  );
  const props: Record<string, unknown> = { key };
  for (const attr of Array.from(element.attributes)) {
    if (attr.name === "class") props.className = attr.value;
    else if (attr.name === "colspan" || attr.name === "rowspan") props[attr.name] = Number(attr.value) || 1;
    else if (attr.name === "scope") props.scope = attr.value;
  }
  return createLayoutElement(tag, props, children);
}

function createLayoutElement(tag: string, props: Record<string, unknown>, children: ReactNode[]) {
  switch (tag) {
    case "table":
      return <table {...props}>{children}</table>;
    case "thead":
      return <thead {...props}>{children}</thead>;
    case "tbody":
      return <tbody {...props}>{children}</tbody>;
    case "tfoot":
      return <tfoot {...props}>{children}</tfoot>;
    case "tr":
      return <tr {...props}>{children}</tr>;
    case "th":
      return <th {...props}>{children}</th>;
    case "td":
      return <td {...props}>{children}</td>;
    case "ul":
      return <ul {...props}>{children}</ul>;
    case "ol":
      return <ol {...props}>{children}</ol>;
    case "li":
      return <li {...props}>{children}</li>;
    case "p":
      return <p {...props}>{children}</p>;
    case "strong":
      return <strong {...props}>{children}</strong>;
    case "b":
      return <b {...props}>{children}</b>;
    case "em":
      return <em {...props}>{children}</em>;
    case "i":
      return <i {...props}>{children}</i>;
    case "br":
      return <br {...props} />;
    case "hr":
      return <hr {...props} />;
    case "span":
      return <span {...props}>{children}</span>;
    default:
      return <div {...props}>{children}</div>;
  }
}

function renderLayoutText(
  text: string,
  key: string,
  group: QuestionGroup,
  values: Record<string, string | string[] | null | undefined>,
  onChange: (questionId: string, value: string | string[] | null) => void,
  disabled?: boolean,
): ReactNode {
  const parts = text.split(/(\{\{\s*q\s*:\s*[^}]+?\s*\}\})/g);
  return (
    <>
      {parts.map((part, index) => {
        const match = part.match(/^\{\{\s*q\s*:\s*([^}]+?)\s*\}\}$/);
        if (!match) return <span key={`${key}-${index}`}>{part}</span>;
        const question = group.questions.find((candidate) => candidate.id === match[1].trim());
        if (!question) return <span key={`${key}-${index}`}>{part}</span>;
        return (
          <QuestionInlineInput
            key={`${key}-${index}`}
            question={question}
            group={group}
            value={values[question.id] ?? null}
            onChange={(value) => onChange(question.id, value)}
            disabled={disabled}
          />
        );
      })}
    </>
  );
}

function QuestionInlineInput({
  question,
  group,
  value,
  onChange,
  disabled,
}: {
  question: Question;
  group: QuestionGroup;
  value: string | string[] | null;
  onChange: (value: string | string[] | null) => void;
  disabled?: boolean;
}) {
  const type = question.type || group.questionType;
  const str = typeof value === "string" ? value : "";
  if (type === "true_false_ng" || type === "yes_no_ng" || type === "single_choice" || type === "matching") {
    const labels = type === "true_false_ng" ? ["TRUE", "FALSE", "NOT GIVEN"] : type === "yes_no_ng" ? ["YES", "NO", "NOT GIVEN"] : [];
    const options = labels.length
      ? labels.map((label) => ({ id: label, label, text: "" }))
      : question.options?.length
        ? question.options
        : group.sharedOptions || [];
    return (
      <select
        className="layout-answer"
        aria-label={`Question ${question.number}`}
        disabled={disabled}
        value={str}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Q{question.number}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label} {option.text}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="layout-answer gap"
      aria-label={`Question ${question.number}`}
      disabled={disabled}
      value={str}
      maxLength={40}
      onChange={(event) => onChange(event.target.value)}
      placeholder={`Q${question.number}`}
    />
  );
}

function QuestionView({
  question,
  group,
  value,
  onChange,
  disabled,
  practice,
}: {
  question: Question;
  group: QuestionGroup;
  value: string | string[] | null;
  onChange: (id: string, v: string | string[] | null) => void;
  disabled?: boolean;
  practice: boolean;
}) {
  const type = question.type || group.questionType;
  const options = question.options?.length ? question.options : group.sharedOptions || [];
  const str = typeof value === "string" ? value : "";

  if (type === "true_false_ng" || type === "yes_no_ng") {
    const labels =
      type === "true_false_ng" ? ["TRUE", "FALSE", "NOT GIVEN"] : ["YES", "NO", "NOT GIVEN"];
    if (practice) {
      return (
        <div className="q-block q-card-block" data-qid={question.id}>
          <div className="q-stem">
            <span className="q-num">{question.number}</span>
            {question.prompt}
          </div>
          <div className="choice-cards tfng">
            {labels.map((lab) => (
              <button
                key={lab}
                type="button"
                className={`choice-card ${str === lab ? "on" : ""}`}
                disabled={disabled}
                onClick={() => onChange(question.id, str === lab ? null : lab)}
              >
                {lab}
              </button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="q-block" data-qid={question.id}>
        <div>
          <span className="q-num">{question.number}</span>
          {question.prompt}
        </div>
        <div className="choices">
          {labels.map((lab) => (
            <label key={lab}>
              <input
                type="radio"
                name={question.id}
                checked={str === lab}
                disabled={disabled}
                onChange={() => onChange(question.id, lab)}
                onClick={() => {
                  if (str === lab) onChange(question.id, null);
                }}
              />
              {lab}
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (type === "single_choice" || type === "multi_choice") {
    if (practice) {
      return (
        <div className="q-block q-card-block" data-qid={question.id}>
          <div className="q-stem">
            <span className="q-num">{question.number}</span>
            {question.prompt}
          </div>
          <div className="choice-cards">
            {options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`choice-card ${str === opt.id ? "on" : ""}`}
                disabled={disabled}
                onClick={() => onChange(question.id, str === opt.id ? null : opt.id)}
              >
                <strong>{opt.label}</strong>
                <span>{opt.text}</span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="q-block" data-qid={question.id}>
        <div>
          <span className="q-num">{question.number}</span>
          {question.prompt}
        </div>
        <div className="choices">
          {options.map((opt) => (
            <label key={opt.id}>
              <input
                type="radio"
                name={question.id}
                checked={str === opt.id}
                disabled={disabled}
                onChange={() => onChange(question.id, opt.id)}
                onClick={() => {
                  if (str === opt.id) onChange(question.id, null);
                }}
              />
              <span>
                <strong>{opt.label}</strong> {opt.text}
              </span>
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (type === "matching") {
    return (
      <div className="q-block" data-qid={question.id}>
        <label>
          <span className="q-num">{question.number}</span>
          {question.prompt}{" "}
          <select
            className="match"
            disabled={disabled}
            value={str}
            onChange={(e) => onChange(question.id, e.target.value || null)}
          >
            <option value=""> </option>
            {options.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label} {opt.text}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (type === "labelling") {
    return (
      <div className="q-block" data-qid={question.id}>
        <label>
          <span className="q-num">{question.number}</span>
          {question.prompt}{" "}
          <input
            className="gap"
            disabled={disabled}
            value={str}
            maxLength={40}
            onChange={(e) => onChange(question.id, e.target.value)}
          />
        </label>
      </div>
    );
  }

  const limit = question.wordLimit || group.wordLimit;
  return (
    <div className="q-block" data-qid={question.id}>
      <label>
        <span className="q-num">{question.number}</span>
        {renderGap(question.gapText || question.prompt, str, (v) => onChange(question.id, v), disabled)}
        {limit ? <span className="meta"> ({limit} word{limit > 1 ? "s" : ""})</span> : null}
      </label>
    </div>
  );
}

function MatchingBoard({
  group,
  values,
  onChange,
  disabled,
  showInstruction = true,
}: {
  showInstruction?: boolean;
  group: QuestionGroup;
  values: Record<string, string | string[] | null | undefined>;
  onChange: (questionId: string, value: string | string[] | null) => void;
  disabled?: boolean;
}) {
  const options = group.sharedOptions || [];
  const [armed, setArmed] = useState<string | null>(null);
  const used = new Set(
    group.questions.map((q) => values[q.id]).filter((v): v is string => typeof v === "string" && v !== ""),
  );

  function assign(questionId: string, optId: string | null) {
    onChange(questionId, optId);
    setArmed(null);
  }

  return (
    <section className="q-group q-group-practice matching-board">
      {showInstruction && (
        <div className="instr" dangerouslySetInnerHTML={{ __html: escapeKeepBreaks(group.instruction) }} />
      )}
      <p className="match-hint">把右侧标签拖到题目上，或先点标签再点空位。键盘可用下拉。</p>
      <div className="match-pool" role="list">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="listitem"
            draggable={!disabled}
            className={`match-chip ${armed === opt.id ? "armed" : ""} ${used.has(opt.id) ? "used" : ""}`}
            disabled={disabled}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", opt.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => setArmed((cur) => (cur === opt.id ? null : opt.id))}
          >
            <strong>{opt.label}</strong>
            <span>{opt.text}</span>
          </button>
        ))}
      </div>
      {group.questions.map((q) => {
        const str = typeof values[q.id] === "string" ? (values[q.id] as string) : "";
        const picked = options.find((o) => o.id === str);
        return (
          <div
            key={q.id}
            className={`match-drop ${str ? "filled" : ""} ${armed ? "awaiting" : ""}`}
            data-qid={q.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (disabled) return;
              const id = e.dataTransfer.getData("text/plain");
              if (id) assign(q.id, id);
            }}
            onClick={() => {
              if (disabled) return;
              if (armed) assign(q.id, armed);
            }}
          >
            <div className="q-stem">
              <span className="q-num">{q.number}</span>
              {q.prompt}
            </div>
            <div className="drop-slot">
              {picked ? (
                <>
                  <strong>{picked.label}</strong> {picked.text}
                  {!disabled && (
                    <button type="button" className="clear-slot" onClick={(e) => { e.stopPropagation(); assign(q.id, null); }}>
                      清除
                    </button>
                  )}
                </>
              ) : (
                <span className="drop-ph">{armed ? "点这里放下" : "拖到这里"}</span>
              )}
            </div>
            <label className="sr-only" htmlFor={`match-${q.id}`}>
              {q.prompt}
            </label>
            <select
              id={`match-${q.id}`}
              className="match sr-fallback"
              disabled={disabled}
              value={str}
              onChange={(e) => onChange(q.id, e.target.value || null)}
            >
              <option value=""> </option>
              {options.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label} {opt.text}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </section>
  );
}

function renderGap(
  text: string,
  value: string,
  onChange: (v: string) => void,
  disabled?: boolean,
) {
  const parts = text.split("____");
  if (parts.length === 1) {
    return (
      <>
        {text}{" "}
        <input className="gap" disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />
      </>
    );
  }
  return (
    <>
      {parts[0]}
      <input className="gap" disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />
      {parts.slice(1).join("____")}
    </>
  );
}

function escapeKeepBreaks(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");
}
