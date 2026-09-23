/**
 * First-run card shown on the Today page exactly once — while no profile
 * exists in IndexedDB. Three questions (target band, exam date, minutes per
 * day), one save, then the real dashboard takes over. Everything here is
 * editable later in 设置.
 */
import { useState, type FormEvent } from "react";
import { saveProfile } from "../api";
import { navigate } from "../nav";
import { isoDay } from "../lib/plan";
import type { Profile } from "../types";
import type { TodayProfile } from "../lib/today";

/** Band 4.0–9.0 in official 0.5 steps. */
const BANDS = Array.from({ length: 11 }, (_, i) => 4 + i * 0.5);
const MINUTE_OPTIONS = [15, 30, 60, 90];

export default function Onboarding({ onSaved }: { onSaved: (profile: Profile) => void }) {
  const [band, setBand] = useState("6.5");
  const [examDate, setExamDate] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const profile: TodayProfile = {
      targetBand: Number(band),
      examDate: examDate || undefined,
      dailyMinutes: minutes,
    };
    try {
      await saveProfile(profile);
      onSaved(profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <section className="workspace-card" style={{ padding: "20px 22px" }}>
      <div className="card-heading">
        <div>
          <h2>先花半分钟定个目标</h2>
          <p>工作台要用它算出「今天该干什么」。之后在「设置」里随时能改。</p>
        </div>
      </div>
      <form onSubmit={submit} style={{ maxWidth: 420 }}>
        <label className="field">
          <span>目标总分（Band）</span>
          <select value={band} onChange={(e) => setBand(e.target.value)}>
            {BANDS.map((b) => (
              <option key={b} value={b.toFixed(1)}>
                {b.toFixed(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>考试日期（不确定可以先不填）</span>
          <input
            type="date"
            value={examDate}
            min={isoDay(new Date())}
            onChange={(e) => setExamDate(e.target.value)}
          />
        </label>
        <div className="field">
          <span>每天可学时长</span>
          <div className="filter-tabs" role="group" aria-label="每天可学时长">
            {MINUTE_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                className={minutes === m ? "active" : ""}
                aria-pressed={minutes === m}
                onClick={() => setMinutes(m)}
              >
                {m} 分钟
              </button>
            ))}
          </div>
        </div>
        {error && <p className="import-error">{error}</p>}
        <div className="button-row">
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "保存中…" : "保存并开始"}
          </button>
          <button type="button" className="secondary-button" onClick={() => navigate("/app/library")}>
            先逛逛题库
          </button>
        </div>
      </form>
    </section>
  );
}
