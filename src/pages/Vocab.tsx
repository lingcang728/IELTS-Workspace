import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { vocabAdd, vocabDelete, vocabDue, vocabList, vocabReview } from "../lib/api";
import { formatDate } from "../lib/format";
import type { VocabCard, VocabGrade, VocabSighting } from "../lib/types";

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

const GRADES: { grade: VocabGrade; label: string; hint: string }[] = [
  { grade: 1, label: "忘了", hint: "重新开始" },
  { grade: 2, label: "勉强", hint: "缩短间隔" },
  { grade: 3, label: "想起来了", hint: "正常间隔" },
  { grade: 4, label: "很简单", hint: "拉长间隔" },
];

export function Vocab() {
  const [all, setAll] = useState<VocabCard[] | null>(null);
  const [due, setDue] = useState<VocabCard[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [term, setTerm] = useState("");
  const [sentence, setSentence] = useState("");
  const [tab, setTab] = useState<"review" | "list">("review");

  async function reload() {
    const [list, queue] = await Promise.all([
      vocabList().catch(() => []),
      vocabDue(50).catch(() => []),
    ]);
    setAll(list);
    setDue(queue);
  }

  useEffect(() => { void reload(); }, []);

  const card = due[0];
  const sighting = card?.sightings?.[0];

  // "You have met this word 3 times" — entirely from real practice records.
  const map = useMemo(() => {
    if (!card) return [];
    return (card.sightings ?? []).filter((s) => s.examTitle);
  }, [card]);

  async function grade(value: VocabGrade) {
    if (!card) return;
    setFlipped(false);
    await vocabReview(card.id, value).catch(() => undefined);
    await reload();
  }

  async function add() {
    const word = term.trim();
    if (!word) return;
    await vocabAdd({
      term: word,
      sighting: sentence.trim() ? { sentence: sentence.trim(), source: "manual" } : undefined,
    }).catch(() => undefined);
    setTerm(""); setSentence("");
    await reload();
  }

  if (all === null) return <div className="page-stack"><PageHeading title="生词本" /></div>;

  return <div className="page-stack vocab-page">
    <PageHeading
      title="生词本"
      subtitle="单词从做过的题里长出来。复习永远先给语境，释义只在翻面之后。"
      aside={<div className="filter-tabs">
        <button type="button" className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>复习 {due.length > 0 && `(${due.length})`}</button>
        <button type="button" className={tab === "list" ? "active" : ""} onClick={() => setTab("list")}>全部 {all.length}</button>
      </div>} />

    {tab === "review" && (card
      ? <section className="workspace-card flashcard">
          <div className="flashcard-context">
            <small>{sighting?.examTitle ? `来自 ${sighting.examTitle}` : "语境"}</small>
            <p>{cloze(sighting, card.term) || "（这张卡片没有语境句）"}</p>
          </div>
          {flipped
            ? <>
                <div className="flashcard-answer">
                  <strong>{card.term}</strong>
                  {card.note && <p>{card.note}</p>}
                  {map.length > 0 && <ul className="vocab-map">{map.map((s, i) =>
                    <li key={i}>在 <b>{s.examTitle}</b> 遇到过</li>)}</ul>}
                </div>
                <div className="flashcard-grades">{GRADES.map((g) =>
                  <button key={g.grade} type="button" onClick={() => void grade(g.grade)}>
                    <strong>{g.label}</strong><small>{g.hint}</small>
                  </button>)}</div>
              </>
            : <button type="button" className="primary-button flashcard-flip" onClick={() => setFlipped(true)}>翻面</button>}
          <footer className="flashcard-meta">
            复习 {card.reps} 次 · 遗忘 {card.lapses} 次
            {card.dueOn && ` · 上次安排到 ${card.dueOn}`}
          </footer>
        </section>
      : <div className="workspace-card empty-state"><Icon name="check" size={42} />
          <h2>今天没有到期的生词</h2>
          <p>{all.length === 0
            ? "在阅读或听力里划词即可入库，卡片会自动带上原句和出处。"
            : "已经全部复习完了。明天再来，或者到「全部」里加词。"}</p></div>)}

    {tab === "list" && <>
      <section className="workspace-card vocab-add">
        <div className="card-heading"><h2>手动添加</h2><span className="meta">做题时划词会自动带上原句，这里适合补录</span></div>
        <div className="vocab-add-row">
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="单词" />
          <input value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder="例句（可留空）" />
          <button type="button" className="secondary-button" onClick={() => void add()}>加入</button>
        </div>
      </section>
      <div className="vocab-list">{all.map((row) => <article className="workspace-card vocab-row" key={row.id}>
        <div>
          <h3>{row.term}</h3>
          <small>{formatDate(row.addedAt)} · 复习 {row.reps} 次{row.dueOn ? ` · 下次 ${row.dueOn}` : " · 未安排"}</small>
          {row.sightings?.[0]?.sentence && <p className="vocab-sentence">{row.sightings[0].sentence}</p>}
        </div>
        <button type="button" className="link-button" onClick={() => void vocabDelete(row.id).then(reload)}>移除</button>
      </article>)}</div>
      {all.length === 0 && <div className="workspace-card empty-state"><Icon name="pen" size={42} />
        <h2>生词本是空的</h2><p>在考场里选中一个词，右键即可加入。</p></div>}
    </>}
  </div>;
}
