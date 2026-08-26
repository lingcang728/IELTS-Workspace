import { Icon } from "../components/Ui";
import { PageHeading } from "../components/Shell";
import { UpdatePanel } from "../components/UpdatePanel";
import type { PracticeScheme, Profile } from "../lib/types";
import type { UiTheme } from "../lib/view";

export function Settings({ profile, theme, onProfile, onImport }: { profile: Profile | null; theme: UiTheme; onProfile: (patch: Partial<Profile>) => void; onImport: () => void }) {
  const targets = [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9];
  const practice = profile?.practiceScheme ?? "follow_shell";
  return <div className="page-stack"><PageHeading title="设置" subtitle="管理备考目标、外观、试卷导入与软件更新" />
    <section className="settings-grid">
      <div className="workspace-card"><Icon name="target" size={28} /><h2>备考目标</h2><p className="meta">填写后，成绩页会算出「距目标还差几题」，工作台会显示考试倒计时。</p>
        <label className="field"><span>目标总分（Band）</span><select value={profile?.targetBand ?? ""} onChange={(e) => onProfile({ targetBand: e.target.value === "" ? undefined : Number(e.target.value) })}><option value="">未设置</option>{targets.map((b) => <option key={b} value={b}>{b.toFixed(1)}</option>)}</select></label>
        <label className="field"><span>考试日期</span><input type="date" value={profile?.examDate ?? ""} onChange={(e) => onProfile({ examDate: e.target.value || undefined })} /></label>
      </div>
      <div className="workspace-card"><Icon name="eye" size={28} /><h2>外观</h2><p className="meta">工作台外壳可深可浅。模考考场固定官方浅色；练习考场可跟随工作台，或单独固定浅色 / 深色。</p>
        <p className="meta">工作台</p>
        <div className="button-row"><button type="button" className={theme === "dark" ? "primary-button" : "secondary-button"} onClick={() => onProfile({ theme: "dark" })}>深色</button><button type="button" className={theme === "light" ? "primary-button" : "secondary-button"} onClick={() => onProfile({ theme: "light" })}>浅色</button></div>
        <p className="meta">练习考场</p>
        <div className="button-row">{([["follow_shell", "跟随工作台"], ["light", "固定浅色"], ["dark", "固定深色"]] as [PracticeScheme, string][]).map(([value, label]) => <button key={value} type="button" className={practice === value ? "primary-button" : "secondary-button"} onClick={() => onProfile({ practiceScheme: value })}>{label}</button>)}</div>
      </div>
      <div className="workspace-card"><Icon name="folder" size={28} /><h2>导入试卷</h2><p className="meta">添加符合 Schema v1 的本地题目。</p><button type="button" className="secondary-button" onClick={onImport}>打开导入</button></div>
      <UpdatePanel />
    </section></div>;
}
