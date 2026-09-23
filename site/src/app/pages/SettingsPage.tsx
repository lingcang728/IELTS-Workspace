import { useEffect, useState } from "react";
import sitePkg from "../../../package.json";
import type { Route } from "../nav";
import { loadProfile, planGet, planSave, saveProfile } from "../api";
import { clearAllData } from "../lib/importer";
import StorageMeter from "../components/StorageMeter";
import type { PracticeScheme, Profile, StudyPlan } from "../types";

const BAND_TARGETS = [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9];
const REPO = "https://github.com/lingcang728/IELTS-Workspace";

/** 跟随系统时按 prefers-color-scheme 解析；[data-ui="light"] 是外壳浅色的开关。 */
function applyShellTheme(theme: Profile["theme"]) {
  const resolved =
    theme ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.ui = resolved;
}

export default function SettingsPage(_props: { route: Route }) {
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([loadProfile(), planGet()]).then(([p, pl]) => {
      if (!alive) return;
      setProfile(p);
      setPlan(pl);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 主题立即生效：写入 profile 的同时直接拨外壳的 data-ui。未设置 = 跟随系统。
  useEffect(() => {
    applyShellTheme(profile?.theme);
    if (profile?.theme) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyShellTheme(undefined);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [profile?.theme]);

  async function patchProfile(patch: Partial<Profile>) {
    const next = { ...(profile ?? {}), ...patch };
    try {
      await saveProfile(next);
      setProfile(next);
      setSaveMsg("已保存");
    } catch (err) {
      setSaveMsg(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function saveDaysPerWeek(n: number) {
    try {
      const next = await planSave({ ...(plan ?? { days: [] }), daysPerWeek: n });
      setPlan(next);
      setSaveMsg("已保存");
    } catch (err) {
      setSaveMsg(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function wipeAll() {
    setClearing(true);
    try {
      await clearAllData();
      window.location.reload();
    } catch (err) {
      setClearing(false);
      setSaveMsg(`清空失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const theme = profile?.theme;
  const practice = profile?.practiceScheme ?? "follow_shell";

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <h1>设置</h1>
          <p>管理备考目标、外观、浏览器存储与本地数据。</p>
        </div>
      </header>
      {!loaded ? (
        <p className="meta">正在读取设置…</p>
      ) : (
        <section className="settings-grid">
          <div className="workspace-card">
            <h2>备考目标</h2>
            <p className="meta">填写后，成绩页会算出「距目标还差几题」，工作台会显示考试倒计时。</p>
            <label className="field">
              <span>目标总分（Band）</span>
              <select
                value={profile?.targetBand ?? ""}
                onChange={(e) =>
                  void patchProfile({ targetBand: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              >
                <option value="">未设置</option>
                {BAND_TARGETS.map((b) => (
                  <option key={b} value={b}>
                    {b.toFixed(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>考试日期</span>
              <input
                type="date"
                value={profile?.examDate ?? ""}
                onChange={(e) => void patchProfile({ examDate: e.target.value || undefined })}
              />
            </label>
            <label className="field">
              <span>每周学习天数</span>
              <select
                value={plan?.daysPerWeek ?? 5}
                onChange={(e) => void saveDaysPerWeek(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                  <option key={n} value={n}>
                    每周 {n} 天
                  </option>
                ))}
              </select>
            </label>
            {saveMsg && <p className="meta">{saveMsg}</p>}
          </div>

          <div className="workspace-card">
            <h2>外观</h2>
            <p className="meta">
              工作台外壳可深可浅。模考考场固定官方浅色；练习考场可跟随工作台，或单独固定浅色 / 深色。
            </p>
            <p className="meta">工作台</p>
            <div className="button-row">
              {(
                [
                  [undefined, "跟随系统"],
                  ["light", "浅色"],
                  ["dark", "深色"],
                ] as [Profile["theme"], string][]
              ).map(([value, label]) => (
                <button
                  key={label}
                  type="button"
                  className={theme === value ? "primary-button" : "secondary-button"}
                  onClick={() => void patchProfile({ theme: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="meta">练习考场</p>
            <div className="button-row">
              {(
                [
                  ["follow_shell", "跟随工作台"],
                  ["light", "固定浅色"],
                  ["dark", "固定深色"],
                ] as [PracticeScheme, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={practice === value ? "primary-button" : "secondary-button"}
                  onClick={() => void patchProfile({ practiceScheme: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="workspace-card">
            <h2>存储</h2>
            <StorageMeter />
          </div>

          <div className="workspace-card">
            <h2>数据管理</h2>
            <p className="meta">
              全部数据都在浏览器 IndexedDB 里。清空会删除所有会话、错题、生词、导入的试卷与音频，不可恢复。
            </p>
            {confirmClear ? (
              <div>
                <p className="notice-strip warning">确认清空？此操作不可撤销。</p>
                <div className="button-row">
                  <button type="button" className="primary-button" disabled={clearing} onClick={() => void wipeAll()}>
                    {clearing ? "正在清空…" : "确认清空"}
                  </button>
                  <button type="button" className="secondary-button" disabled={clearing} onClick={() => setConfirmClear(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="button-row">
                <button type="button" className="secondary-button" onClick={() => setConfirmClear(true)}>
                  清空全部数据
                </button>
              </div>
            )}
          </div>

          <div className="workspace-card">
            <h2>关于</h2>
            <p className="meta">IELTS Workspace 网页版 v{sitePkg.version}</p>
            <p className="meta">
              <a href={REPO} target="_blank" rel="noreferrer">
                GitHub 仓库
              </a>
            </p>
            <p className="meta">题库整理供个人学习，请支持正版剑桥教材。</p>
          </div>
        </section>
      )}
    </div>
  );
}
