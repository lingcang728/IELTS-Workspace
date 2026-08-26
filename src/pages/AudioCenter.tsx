import { useMemo } from "react";
import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { listeningReady } from "../lib/audio";
import type { ExamSummary } from "../lib/types";

const BOOKS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] as const;
const TESTS = [1, 2, 3, 4] as const;

function examId(book: number, test: number) {
  return `cambridge-${book}-test-${test}-listening`;
}

export function AudioCenter({
  exams,
  onAdd,
  onOpenGuide,
  onRemove,
}: {
  exams: ExamSummary[];
  onAdd: (examId?: string) => void;
  onOpenGuide: () => void;
  onRemove: (examId: string) => void;
}) {
  const byId = useMemo(() => {
    const map = new Map<string, ExamSummary>();
    for (const exam of exams) {
      if (exam.module === "listening") map.set(exam.id, exam);
    }
    return map;
  }, [exams]);

  const books = useMemo(() => BOOKS.map((book) => ({
    book,
    tests: TESTS.map((test) => {
      const exam = byId.get(examId(book, test));
      const ready = listeningReady(exam?.audioStatus);
      const review = exam?.audioStatus === "needsReview";
      return { test, exam, ready, review };
    }),
  })), [byId]);

  const total = BOOKS.length * TESTS.length;
  const bound = books.reduce((n, row) => n + row.tests.filter((t) => t.ready).length, 0);

  return (
    <div className="page-stack audio-page">
      <PageHeading
        title="添加听力音频"
        subtitle="剑 4 到剑 20，每套四个 Part。绿色打勾是已经加上的，灰色还没加。"
        aside={<div className="button-row">
          <button type="button" className="secondary-button" onClick={onOpenGuide}>打开下载指南</button>
          <button type="button" className="primary-button" onClick={() => onAdd()}>添加音频</button>
        </div>}
      />
      <section className="workspace-card">
        <p className="meta">已添加 {bound} / {total} 套 · 选择文件夹时可一次勾多个。C21 没有 Listening。</p>
      </section>
      <div className="audio-board">
        {books.map((row) => {
          const done = row.tests.filter((t) => t.ready).length;
          return (
            <section key={row.book} className="workspace-card audio-book">
              <div className="audio-book-head">
                <h2>剑 {row.book}</h2>
                <span className="meta">{done} / 4</span>
              </div>
              <div className="audio-tests">
                {row.tests.map((cell) => {
                  const label = `Test ${cell.test}`;
                  if (cell.ready && cell.exam) {
                    return (
                      <div key={cell.test} className="audio-test ready">
                        <span className="audio-test-mark" aria-hidden="true"><Icon name="check" size={16} /></span>
                        <strong>{label}</strong>
                        <small>已添加</small>
                        <button type="button" className="link-button" onClick={() => onRemove(cell.exam!.id)}>移除</button>
                      </div>
                    );
                  }
                  const state = cell.review ? "review" : "missing";
                  const caption = cell.review ? "需重导" : "未添加";
                  return (
                    <button
                      key={cell.test}
                      type="button"
                      className={`audio-test ${state}`}
                      onClick={() => cell.exam ? onAdd(cell.exam.id) : onAdd()}
                    >
                      <span className="audio-test-mark" aria-hidden="true" />
                      <strong>{label}</strong>
                      <small>{caption}</small>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
