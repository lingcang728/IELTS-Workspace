/**
 * 「组一套题」弹层：听力 P1–P4 / 阅读 P1–P3 每个槽位挑一套源卷，或交给
 * 「随机未练」。合成走 lib/compose.ts 的 composeExam——题号重排、id 加前缀、
 * 听力跨卷时把已导入的 part 音频拼成一条 WAV。确认后直接存 IDB 并进模考。
 */
import { useMemo, useState } from "react";
import { importExam } from "../api";
import type { IndexedExam } from "../content";
import {
  composeExam,
  composeSlots,
  randomSlotPick,
  slotOptions,
  type ComposeModule,
  type SlotOption,
} from "../lib/compose";
import { navigate } from "../nav";
import { activityStatus, type ExamActivity } from "./LibraryRow";

const AUTO = "auto";

function optionText(o: SlotOption, module: ComposeModule): string {
  const bits = [o.label];
  if (o.status === "done") bits.push("已练");
  if (o.status === "open") bits.push("进行中");
  if (module === "listening" && !o.audioReady) bits.push("无音频");
  return bits.join(" · ");
}

export function LibraryCompose({
  module,
  exams,
  activity,
  onClose,
}: {
  module: ComposeModule;
  exams: IndexedExam[];
  activity: Map<string, ExamActivity>;
  onClose: () => void;
}) {
  const slots = useMemo(() => composeSlots(module), [module]);
  const optionsBySlot = useMemo(
    () =>
      slots.map((slot) =>
        slotOptions(module, slot.index, exams, (id) => activityStatus(activity.get(id))),
      ),
    [slots, module, exams, activity],
  );
  const [picks, setPicks] = useState<string[]>(() => slots.map(() => AUTO));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setPick = (index: number, value: string) =>
    setPicks((prev) => prev.map((v, i) => (i === index ? value : v)));

  const slotHint = (index: number): string => {
    const options = optionsBySlot[index];
    if (!options.length) return "没有可用的源卷";
    if (picks[index] === AUTO) {
      const fresh = options.filter((o) => o.status === "none").length;
      return fresh > 0 ? `将从 ${fresh} 套未练卷中随机选取` : "未练卷已用完，将从全部卷中随机";
    }
    const chosen = options.find((o) => o.examId === picks[index]);
    if (!chosen) return "";
    const bits = [
      chosen.status === "none" ? "未练" : chosen.status === "open" ? "进行中" : "已练",
    ];
    if (module === "listening") bits.push(chosen.audioReady ? "音频已导入" : "音频未导入");
    return bits.join(" · ");
  };

  const confirm = async () => {
    setError(null);
    setBusy("正在选择试卷…");
    try {
      const taken = new Set<string>();
      const resolved = slots.map((slot, i) => {
        let examId = picks[i];
        if (examId === AUTO) examId = randomSlotPick(optionsBySlot[i], taken) ?? "";
        if (!optionsBySlot[i].some((o) => o.examId === examId)) {
          throw new Error(`没有可用于 ${slot.label} 的源卷`);
        }
        taken.add(examId);
        return { examId, sectionIndex: slot.index };
      });
      setBusy(
        module === "listening" ? "正在合成试卷并拼接音频…" : "正在合成试卷…",
      );
      const composed = await composeExam(module, resolved);
      await importExam(JSON.stringify(composed.exam));
      navigate("/app/exam", { exam: composed.exam.id, mode: "mock" });
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "组卷失败，请重试");
    }
  };

  return (
    <div
      role="presentation"
      onClick={() => !busy && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        display: "grid",
        placeItems: "center",
        padding: 16,
        background: "var(--scrim)",
      }}
    >
      <section
        className="workspace-card"
        role="dialog"
        aria-modal="true"
        aria-label="组一套题"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 94vw)",
          maxHeight: "86vh",
          overflowY: "auto",
          padding: "20px 22px",
        }}
      >
        <div className="card-heading">
          <div>
            <h2>组一套{module === "listening" ? "听力" : "阅读"}模考</h2>
            <p>
              {module === "listening"
                ? "从 P1–P4 各选一个 Part，合成一张 4 部分新卷"
                : "从 P1–P3 各选一篇文章，合成 60 分钟新卷"}
            </p>
          </div>
          <button type="button" className="link-button" onClick={onClose} disabled={!!busy}>
            关闭
          </button>
        </div>

        {module === "listening" && (
          <div className="notice-strip" style={{ marginTop: 12, marginBottom: 0 }}>
            各部分来自不同试卷时，会自动把各源卷的听力音频拼成一条音轨；任一来源的音频暂时取不到，合成卷就没有音频。
          </div>
        )}

        {slots.map((slot, i) => (
          <div className="field" key={slot.index}>
            <span>
              {slot.label}
              {module === "listening" ? ` · 第 ${i + 1} 部分` : ` · 第 ${i + 1} 篇`}
            </span>
            <label className="select-field" style={{ display: "flex" }}>
              <select
                value={picks[i]}
                disabled={!!busy}
                onChange={(e) => setPick(i, e.target.value)}
                style={{ flex: 1 }}
              >
                <option value={AUTO}>随机未练（没有则随机）</option>
                {optionsBySlot[i].map((o) => (
                  <option key={o.examId} value={o.examId}>
                    {optionText(o, module)}
                  </option>
                ))}
              </select>
            </label>
            <small className="meta">{slotHint(i)}</small>
          </div>
        ))}

        {error && (
          <p className="import-error" role="alert">
            {error}
          </p>
        )}

        <div className="button-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="secondary-button" onClick={onClose} disabled={!!busy}>
            取消
          </button>
          <button type="button" className="primary-button" onClick={confirm} disabled={!!busy}>
            {busy ?? "生成并开始模考"}
          </button>
        </div>
      </section>
    </div>
  );
}
