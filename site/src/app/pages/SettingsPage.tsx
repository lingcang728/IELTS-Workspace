import { useEffect, useState } from "react";
import sitePkg from "../../../package.json";
import type { Route } from "../nav";
import { idbGet, idbSet, loadProfile, planGet, planSave, saveProfile } from "../api";
import { clearAllData } from "../lib/dataOps";
import StorageMeter from "../components/StorageMeter";
import type { PracticeScheme, Profile, StudyPlan } from "../types";

const BAND_TARGETS = [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9];
const REPO = "https://github.com/lingcang728/IELTS-Workspace";
/** 顶栏主题开关读的是 kv["ui-theme"]（"light"|"dark"|"follow"），
    设置页这里必须同步写它，否则刷新后顶栏选择会覆盖这里的设置。 */
const THEME_KEY = "ui-theme";

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
  // 三档选择以 kv["ui-theme"] 为准（"light"|"dark"|"follow"）——Shell 读它、
  // 顶栏开关显示它；profile.theme 只是镜像，首次访问时可能还没被回填。
  const [uiTheme, setUiTheme] = useState<"light" | "dark" | "follow" | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([loadProfile(), planGet(), idbGet<"light" | "dark" | "follow">("kv", THEME_KEY)]).then(
      ([p, pl, kv]) => {
        if (!alive) return;
        setProfile(p);
        setPlan(pl);
        // 空值回落与 Shell 保持一致（kv/profile 都没有 = 新用户默认深色），
        // 避免 Shell 还没把默认深色写回 kv 时这里先显示成「跟随系统」。
        setUiTheme(kv ?? p?.theme ?? "dark");
        setLoaded(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // 主题由 Shell 统一拨 data-ui（挂载时读 kv["ui-theme"]）。这里只补一个
  // 「跟随系统」的监听：用户在设置页选了跟随后，系统翻转时外壳也要跟上 —
  // Shell 只在它自己的 choice==="follow" 时监听，profile.theme===undefined
  // 同样是跟随语义。注意绝不能在挂载时主动 applyShellTheme：profile 尚未
  // 加载时是 undefined，会把 Shell 已生效的深色错刷成系统浅色。
  useEffect(() => {
    if (uiTheme !== "follow") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyShellTheme(undefined);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [uiTheme]);

  /** 工作台主题三档：profile.theme 存具体值（undefined=跟随），kv 存原始选择。 */
  async function applyThemeChoice(value: Profile["theme"]) {
    applyShellTheme(value);
    setUiTheme(value ?? "follow");
    try {
      await idbSet("kv", THEME_KEY, value ?? "follow");
    } catch {
      // kv 写失败不挡 profile 写入——下次启动只是回不到「跟随」这一档
    }
    await patchProfile({ theme: value });
  }

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

  const theme: Profile["theme"] = uiTheme === "follow" ? undefined : (uiTheme ?? undefined);
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
            {saveMsg && (
              <p
                className="settings-saved"
                style={{ color: saveMsg === "已保存" ? "var(--positive)" : "var(--danger)" }}
              >
                {saveMsg}
              </p>
            )}
          </div>

          <div className="workspace-card">
            <h2>外观</h2>
            <p className="meta">
              工作台外壳可深可浅。模考考场固定官方浅色；练习考场可跟随工作台，或单独固定浅色 / 深色。
            </p>
            <div className="settings-group">
              <span className="settings-group-label">工作台</span>
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
                    onClick={() => void applyThemeChoice(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-group">
              <span className="settings-group-label">练习考场</span>
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
          </div>

          <div className="workspace-card">
            <h2>存储</h2>
            <StorageMeter />
          </div>

          <div className="workspace-card">
            <h2>数据管理</h2>
            <p className="meta">
              全部数据都在浏览器 IndexedDB 里。清空会删除所有会话、错题、生词与音频缓存，不可恢复。
            </p>
            {confirmClear ? (
              <div>
                <p className="notice-strip warning">确认清空？此操作不可撤销。</p>
                <div className="button-row">
                  <button type="button" className="danger-button" disabled={clearing} onClick={() => void wipeAll()}>
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
