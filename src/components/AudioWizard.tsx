import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Ui";
import {
  audioConfirmImport,
  audioPickFiles,
  audioPickFolder,
  audioScanPaths,
  audioSetManualParts,
  audioWaveform,
  localMediaSrc,
  type AudioImportCandidate,
  type AudioImportPlan,
  type Waveform,
} from "../lib/audio";

export function AudioWizard({
  targetExamId,
  onClose,
  onDone,
}: {
  targetExamId?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<AudioImportPlan | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [calibrate, setCalibrate] = useState<AudioImportCandidate | null>(null);

  async function scan(paths: string[]) {
    if (!paths.length) return;
    setBusy(true);
    setError(null);
    try {
      const next = await audioScanPaths(paths);
      setPlan(next);
      const flags: Record<string, boolean> = {};
      for (const c of next.ready) flags[c.path] = true;
      for (const c of next.needsConfirm) flags[c.path] = false;
      setAccepted(flags);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickFiles() {
    const files = await audioPickFiles().catch((e) => {
      setError(String(e));
      return [];
    });
    await scan(files);
  }

  async function pickFolder() {
    const folder = await audioPickFolder().catch((e) => {
      setError(String(e));
      return null;
    });
    if (folder) await scan([folder]);
  }

  async function confirm() {
    if (!plan) return;
    const chosen = [
      ...plan.ready,
      ...plan.needsConfirm.filter((c) => accepted[c.path]),
    ];
    if (!chosen.length) {
      setError("请先勾选要导入的文件。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await audioConfirmImport(chosen);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const unknown = plan?.unknown ?? [];

  return (
    <div className="audio-wizard-backdrop" role="dialog" aria-modal="true" aria-labelledby="audio-wizard-title">
      <div className="audio-wizard">
        <header>
          <h2 id="audio-wizard-title">添加听力音频</h2>
          <button type="button" className="ghost-icon" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>
        <p className="meta">
          {targetExamId ? `正在为 ${targetExamId} 添加。` : "可一次导入多套。"}
          支持 MP3 / M4A / WAV、整轨、四个 Part、文件夹和官方分册 ZIP。文件只复制到本机数据目录。
        </p>
        <div className="button-row">
          <button type="button" className="primary-button" disabled={busy} onClick={() => void pickFiles()}>选择文件</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void pickFolder()}>选择文件夹</button>
        </div>
        {error && <p className="form-error">{error}</p>}
        {plan && (
          <div className="audio-plan">
            {plan.errors.length > 0 && <ul className="audio-errors">{plan.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            {plan.ready.length > 0 && <h3>将自动导入</h3>}
            {plan.ready.map((c) => <CandidateRow key={c.path} c={c} checked readOnly />)}
            {plan.needsConfirm.length > 0 && <h3>需要确认</h3>}
            {plan.needsConfirm.map((c) => (
              <CandidateRow
                key={c.path}
                c={c}
                checked={Boolean(accepted[c.path])}
                onToggle={(v) => setAccepted((prev) => ({ ...prev, [c.path]: v }))}
              />
            ))}
            {unknown.length > 0 && (
              <>
                <h3>未知整轨（手动标记 Part）</h3>
                {unknown.map((c) => (
                  <article key={c.path} className="audio-candidate">
                    <div>
                      <strong>{c.fileName}</strong>
                      <small>{c.reason} · {Math.round(c.durationMs / 1000)} 秒</small>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => setCalibrate(c)}>校准</button>
                  </article>
                ))}
              </>
            )}
            <div className="button-row">
              <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>确认导入</button>
              <button type="button" className="secondary-button" onClick={onClose}>取消</button>
            </div>
          </div>
        )}
        {calibrate && (
          <Calibrator
            candidate={calibrate}
            examId={targetExamId || calibrate.examId || ""}
            onCancel={() => setCalibrate(null)}
            onSaved={() => { setCalibrate(null); onDone(); }}
          />
        )}
      </div>
    </div>
  );
}

function CandidateRow({ c, checked, readOnly, onToggle }: { c: AudioImportCandidate; checked: boolean; readOnly?: boolean; onToggle?: (v: boolean) => void }) {
  return (
    <label className="audio-candidate">
      <input type="checkbox" checked={checked} disabled={readOnly} onChange={(e) => onToggle?.(e.target.checked)} />
      <div>
        <strong>{c.fileName}</strong>
        <small>{c.examId || "未匹配"}{c.partIndex ? ` · Part ${c.partIndex}` : ""} · {c.reason}</small>
      </div>
    </label>
  );
}

function Calibrator({
  candidate,
  examId,
  onCancel,
  onSaved,
}: {
  candidate: AudioImportCandidate;
  examId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [wave, setWave] = useState<Waveform | null>(null);
  const [starts, setStarts] = useState<number[]>([0, 0, 0, 0]);
  const [marking, setMarking] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    void audioWaveform(candidate.path).then(setWave).catch((e) => setError(String(e)));
  }, [candidate.path]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !wave) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted-2").trim() || "currentColor";
    const mid = h / 2;
    wave.peaks.forEach((p, i) => {
      const x = (i / wave.peaks.length) * w;
      const y = p * (h * 0.45);
      ctx.fillRect(x, mid - y, Math.max(1, w / wave.peaks.length), y * 2);
    });
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "currentColor";
    [ink, ink, ink, ink].forEach((color, i) => {
      const x = (starts[i] / Math.max(1, wave.durationMs)) * w;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    });
  }, [wave, starts]);

  function markAt(ratio: number) {
    if (!wave) return;
    const ms = Math.round(ratio * wave.durationMs);
    setStarts((prev) => {
      const next = [...prev];
      next[marking] = ms;
      return next;
    });
  }

  async function save() {
    if (!examId) {
      setError("请先从试卷行进入添加音频，以便知道这是哪一套题。");
      return;
    }
    const ordered = [...starts].sort((a, b) => a - b);
    if (ordered[0] > 2000) ordered[0] = 0;
    try {
      await audioSetManualParts(examId, ordered, candidate.path);
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  const src = useMemo(() => localMediaSrc(candidate.path), [candidate.path]);

  return (
    <div className="audio-calibrator">
      <h3>标记 Part 1-4 起点</h3>
      <p className="meta">点波形或拖进度条试听。四个起点从左到右对应 Part 1 到 Part 4。Part 1 通常是 0。</p>
      {error && <p className="form-error">{error}</p>}
      <canvas
        ref={canvasRef}
        width={720}
        height={88}
        className="audio-wave"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          markAt((e.clientX - rect.left) / rect.width);
        }}
      />
      <div className="button-row">
        {[0, 1, 2, 3].map((i) => (
          <button key={i} type="button" className={marking === i ? "primary-button" : "secondary-button"} onClick={() => setMarking(i)}>
            Part {i + 1} {wave ? formatMs(starts[i]) : ""}
          </button>
        ))}
      </div>
      <audio ref={audioRef} src={src} controls />
      <div className="button-row">
        <button type="button" className="primary-button" onClick={() => void save()}>保存绑定</button>
        <button type="button" className="secondary-button" onClick={onCancel}>返回</button>
      </div>
    </div>
  );
}

function formatMs(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
