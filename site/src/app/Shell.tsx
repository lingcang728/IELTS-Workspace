/**
 * 工作台外壳 —— 顶部条（品牌 / 回官网 / 主题切换）+ 左侧导航。
 *
 * 只在 `route.isApp && !isExamRoute(route)` 时由 App.tsx 渲染；
 * 考场路由全屏，不经过这里，考场视觉域（--exam-*）因此与外壳主题完全隔离。
 *
 * 主题：三档 浅色 / 深色 / 跟随系统。
 *   - 选择存 kv["ui-theme"]（"light" | "dark" | "follow"）；
 *   - 同时把解析后的具体值镜像进 profile.theme（loadProfile/saveProfile），
 *     让只读 profile 的页面拿到的永远是一个确定的 "light" | "dark"；
 *   - 生效方式是把解析结果写到 documentElement.dataset.ui（tokens.css 的
 *     `[data-ui="light"]` 选择器）和 dataset.theme。
 */
import { useEffect, useState, type ReactNode } from "react";
import { href, useRoute } from "./nav";
import { idbGet, idbSet, loadProfile, saveProfile } from "./api";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/practice.css";
import "./styles/exam.css";
import "./styles/app.css";

type ThemeChoice = "light" | "dark" | "follow";
type ResolvedTheme = "light" | "dark";
type IconName =
  | "today"
  | "library"
  | "chart"
  | "mistakes"
  | "vocab"
  | "history"
  | "import"
  | "settings";

const THEME_KEY = "ui-theme";

interface NavItem {
  /** route.segments[1]，空串 = #/app 今日工作台 */
  seg: string;
  label: string;
  icon: IconName;
}

const NAV_MAIN: NavItem[] = [
  { seg: "", label: "今日", icon: "today" },
  { seg: "library", label: "题库", icon: "library" },
];

const NAV_STUDY: NavItem[] = [
  { seg: "analytics", label: "分析", icon: "chart" },
  { seg: "mistakes", label: "错题本", icon: "mistakes" },
  { seg: "vocab", label: "生词", icon: "vocab" },
];

const NAV_MISC: NavItem[] = [
  { seg: "history", label: "历史", icon: "history" },
  { seg: "import", label: "导入", icon: "import" },
  { seg: "settings", label: "设置", icon: "settings" },
];

const ALL_ITEMS = [...NAV_MAIN, ...NAV_STUDY, ...NAV_MISC];

/* ------------------------------------------------------------------ icons */

const ICONS: Record<IconName, ReactNode> = {
  today: (
    <>
      <rect x="3.5" y="4.5" width="13" height="12" rx="1.5" />
      <path d="M3.5 8.2h13M7 3v3M13 3v3" />
    </>
  ),
  library: (
    <>
      <path d="M10 5.4C8.6 4.5 6.8 4.3 5 4.7v10.9c1.8-.4 3.6-.2 5 .7 1.4-.9 3.2-1.1 5-.7V4.7c-1.8-.4-3.6-.2-5 .7z" />
      <path d="M10 5.4v10.9" />
    </>
  ),
  chart: (
    <>
      <path d="M3.5 3.5v13h13" />
      <path d="M7 13.5v-4M10.7 13.5V7M14.3 13.5V9.5" />
    </>
  ),
  mistakes: (
    <>
      <path d="M16.2 10a6.2 6.2 0 1 1-1.9-4.5" />
      <path d="M16.5 2.8v3.6h-3.6" />
    </>
  ),
  vocab: (
    <path d="M6 3.5h8a.5.5 0 0 1 .5.5v12.3l-4.5-3.2-4.5 3.2V4a.5.5 0 0 1 .5-.5z" />
  ),
  history: (
    <>
      <path d="M4.2 10a5.8 5.8 0 1 1 1.7 4.1" />
      <path d="M3.7 14.8v-3.3h3.3" />
      <path d="M10 6.6V10l2.6 1.8" />
    </>
  ),
  import: (
    <>
      <path d="M10 3.2v7.6M6.8 7.6 10 10.8l3.2-3.2" />
      <path d="M4 12.8v2.7A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-2.7" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 3.2v1.8M10 15v1.8M16.8 10H15M5 10H3.2M14.9 5.1l-1.3 1.3M6.4 13.6l-1.3 1.3M14.9 14.9l-1.3-1.3M6.4 6.4 5.1 5.1" />
    </>
  ),
};

function ShellIcon({ name, size = 19 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="ws-icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

/* ------------------------------------------------------------------ theme */

function useShellTheme(): { choice: ThemeChoice; choose: (t: ThemeChoice) => void } {
  const [choice, setChoice] = useState<ThemeChoice>("light");
  const [systemDark, setSystemDark] = useState<boolean>(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  // 跟随系统：监听 prefers-color-scheme
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 首次加载：kv["ui-theme"] 优先，其次 profile.theme，默认浅色
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [stored, profile] = await Promise.all([
        idbGet<ThemeChoice>("kv", THEME_KEY),
        loadProfile(),
      ]);
      if (cancelled) return;
      setChoice(stored ?? profile?.theme ?? "light");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolved: ResolvedTheme =
    choice === "follow" ? (systemDark ? "dark" : "light") : choice;

  // 应用到 <html>：data-ui 驱动 tokens.css，data-theme 供其他读者使用
  useEffect(() => {
    document.documentElement.dataset.ui = resolved;
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  // follow 模式下系统主题翻转时，把镜像值也刷新进 profile.theme
  useEffect(() => {
    if (choice !== "follow") return;
    void (async () => {
      const profile = (await loadProfile()) ?? {};
      if (profile.theme !== resolved) await saveProfile({ ...profile, theme: resolved });
    })();
  }, [choice, resolved]);

  const choose = (next: ThemeChoice) => {
    setChoice(next);
    const concrete: ResolvedTheme =
      next === "follow" ? (systemDark ? "dark" : "light") : next;
    void (async () => {
      const profile = (await loadProfile()) ?? {};
      await Promise.all([
        idbSet("kv", THEME_KEY, next),
        saveProfile({ ...profile, theme: concrete }),
      ]);
    })();
  };

  return { choice, choose };
}

/* ------------------------------------------------------------------ shell */

export default function Shell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const { choice, choose } = useShellTheme();

  const seg = route.segments[1] ?? "";
  // routes.tsx 对未知段回落到今日工作台，导航高亮保持一致
  const current = ALL_ITEMS.some((item) => item.seg === seg) ? seg : "";

  const navLink = (item: NavItem) => (
    <a
      key={item.seg === "" ? "today" : item.seg}
      href={href(item.seg === "" ? "/app" : `/app/${item.seg}`)}
      className={current === item.seg ? "selected" : undefined}
      aria-current={current === item.seg ? "page" : undefined}
    >
      <ShellIcon name={item.icon} />
      <span>{item.label}</span>
    </a>
  );

  const themeLabel: Record<ThemeChoice, string> = {
    light: "浅色",
    dark: "深色",
    follow: "跟随",
  };

  return (
    <div className="app-shell ws-shell">
      <header className="ws-topbar">
        <a className="ws-brand" href="#/" title="返回官网">
          <img src="/logo.png" width={22} height={22} alt="" />
          <span>IELTS Workspace</span>
        </a>
        <div className="ws-topbar-right">
          <div className="ws-theme" role="group" aria-label="界面主题">
            {(["light", "dark", "follow"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={choice === t}
                onClick={() => choose(t)}
              >
                {themeLabel[t]}
              </button>
            ))}
          </div>
          <a className="ws-home-link" href="#/">
            回官网
          </a>
        </div>
      </header>

      <div className="app-frame ws-frame">
        <aside className="sidebar ws-sidebar">
          <nav className="side-nav ws-side-nav" aria-label="主导航">
            {NAV_MAIN.map(navLink)}
          </nav>
          <div className="ws-nav-rule" />
          <nav className="side-nav ws-side-nav" aria-label="学习记录">
            {NAV_STUDY.map(navLink)}
          </nav>
          <div className="sidebar-spacer" />
          <nav className="side-nav ws-side-nav" aria-label="辅助导航">
            {NAV_MISC.map(navLink)}
          </nav>
        </aside>
        <main className="workspace-main ws-main">{children}</main>
      </div>
    </div>
  );
}
