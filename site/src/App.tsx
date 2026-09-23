import { useLayoutEffect } from "react";
import sitePkg from "../package.json";
import { useRoute } from "./app/nav";
import { WorkspaceRoutes, isExamRoute } from "./app/routes";
import Shell from "./app/Shell";

const VERSION = sitePkg.version;
const INSTALLER =
  `https://github.com/lingcang728/IELTS-Workspace/releases/latest/download/IELTS_Workspace_${VERSION}_x64-setup.exe`;
const PORTABLE =
  `https://github.com/lingcang728/IELTS-Workspace/releases/latest/download/IELTS_Workspace_${VERSION}_x64.exe`;
const REPO = "https://github.com/lingcang728/IELTS-Workspace";
const SHA256SUMS = `${REPO}/releases/latest/download/SHA256SUMS.txt`;
const AUDIO_TAG = "listening-audio-v1";

const BOOKS = Array.from({ length: 17 }, (_, i) => {
  const n = i + 4;
  const id = `C${String(n).padStart(2, "0")}`;
  const file = `${id}-listening.zip`;
  return {
    id,
    name: `剑桥雅思 ${n}`,
    file,
    href: `https://github.com/lingcang728/IELTS-Workspace/releases/download/${AUDIO_TAG}/${file}`,
  };
});

/**
 * 双区入口：
 *   #/            —— 官网落地页（editorial 米白 + 朱砂，data-page="landing"）
 *   #/app/**      —— 工作台，套 Shell（data-page="app"）
 *   #/app/exam    —— 考场全屏，不套 Shell（data-page="exam"）
 *
 * data-page 写在 <html> 上，落地页样式（styles.css）全部以它限定作用域，
 * 与工作台 tokens 互不污染。useLayoutEffect 保证首帧前生效，不会闪深色。
 */
export default function App() {
  const route = useRoute();
  const page = !route.isApp ? "landing" : isExamRoute(route) ? "exam" : "app";

  useLayoutEffect(() => {
    document.documentElement.dataset.page = page;
    // 从工作台跳到落地页栏目锚点（如 #listening）时，hashchange 触发渲染，
    // 但浏览器原生锚点滚动在元素挂载前已经落空，这里补一次。
    if (page === "landing" && route.segments.length === 1) {
      document.getElementById(route.segments[0])?.scrollIntoView();
    }
  }, [page, route]);

  if (route.isApp) {
    if (isExamRoute(route)) return <WorkspaceRoutes route={route} />;
    return (
      <Shell>
        <WorkspaceRoutes route={route} />
      </Shell>
    );
  }
  return <Landing />;
}

function Landing() {
  return (
    <>
      <a className="skip" href="#main">
        跳到正文
      </a>

      <header className="site-header">
        <div className="wrap bar">
          <a className="brand" href="#top">
            <img src="/logo.png" width={32} height={32} alt="" />
            <span>IELTS Workspace</span>
          </a>
          <nav aria-label="页面栏目">
            <a href="#/app">在线练习</a>
            <a href="#intro">介绍</a>
            <a href="#download">下载</a>
            <a href="#listening">听力音频</a>
            <a href="#data">数据目录</a>
          </nav>
        </div>
      </header>

      <main id="main">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="wrap">
            <p className="kicker">Windows · 网页版 · 本地优先</p>
            <h1 id="hero-title">IELTS Workspace</h1>
            <p className="lede">本地优先的雅思机考工作台。</p>
            <p className="sub">
              网页版浏览器内直接做题，听力音频已内置、点开即听；桌面版 Reading 与
              Writing 开箱即用。不内置 AI，无遥测。
            </p>
            <p className="cta-row">
              <a className="btn btn-primary" href="#/app">
                进入在线练习（免安装）
              </a>
              <a className="btn btn-secondary" href={REPO} rel="noreferrer" target="_blank">
                ⭐ 去 GitHub 点 Star
              </a>
              <a className="btn btn-secondary" href={INSTALLER}>
                下载安装版
              </a>
              <a className="btn btn-secondary" href={PORTABLE}>
                下载便携版
              </a>
            </p>
          </div>
        </section>

        <section id="intro" aria-labelledby="intro-title">
          <div className="wrap">
            <p className="kicker">About</p>
            <h2 id="intro-title">介绍</h2>
            <p>
              IELTS Workspace 是雅思 Academic 机考工作台。练习、Mock
              模考、划线笔记和交卷复盘都在本地，不为刷题平台做账号或广告。
            </p>
            <p className="web-note">
              <strong>网页版现已可用：</strong>
              浏览器内做题、记录保存在本地 IndexedDB、可安装为应用。
              <a href="#/app">进入在线练习</a>。
            </p>
            <ul className="facts">
              <li>
                <h3>Reading / Writing</h3>
                <p>开箱即用。题库随应用提供，打开即可按模块练习或按套卷模考。</p>
              </li>
              <li>
                <h3>Listening</h3>
                <p>
                  网页版音频已随站点内置，点开即练。桌面版音频包见下方「听力音频」一节。
                </p>
              </li>
              <li>
                <h3>本地与隐私</h3>
                <p>
                  不内置 AI，无遥测。除检查更新外不发起网络请求。会话、高亮和笔记留在你指定的数据目录。
                </p>
              </li>
            </ul>
            <figure className="shot">
              <img
                src="/preview.png"
                width={1600}
                height={900}
                alt="IELTS Workspace 练习中心。左侧导航，中间题库列表，右侧继续练习与本周练习。"
              />
              <figcaption>练习中心：题库、模块练习与本地数据入口。</figcaption>
            </figure>
          </div>
        </section>

        <section id="download" aria-labelledby="download-title">
          <div className="wrap">
            <p className="kicker">Download</p>
            <h2 id="download-title">下载</h2>
            <p>
              Windows 10 / 11 x64。安装版支持应用内更新，便携版可整夹拷走。下载后可用{" "}
              <code className="path">certutil -hashfile 文件名 SHA256</code> 核对，哈希清单见{" "}
              <a href={SHA256SUMS} rel="noreferrer" target="_blank">
                SHA256SUMS.txt
              </a>
              。
            </p>
            <div className="dl-grid">
              <article className="dl-card">
                <p className="badge">推荐</p>
                <h3>安装版</h3>
                <p className="file">IELTS_Workspace_{VERSION}_x64-setup.exe</p>
                <p>
                  安装到本机，数据写在{" "}
                  <code className="path">%LOCALAPPDATA%\IELTS Workspace User Data\data</code>。
                </p>
                <a className="btn btn-primary" href={INSTALLER}>
                  下载安装版
                </a>
              </article>
              <article className="dl-card">
                <p className="badge badge-quiet">绿色</p>
                <h3>便携版</h3>
                <p className="file">IELTS_Workspace_{VERSION}_x64.exe</p>
                <p>
                  单文件运行，数据写在 <code className="path">&lt;EXE目录&gt;\data</code>。
                </p>
                <a className="btn btn-secondary" href={PORTABLE}>
                  下载便携版
                </a>
              </article>
            </div>
            <article className="star-card">
              <div>
                <h3>开源项目</h3>
                <p>
                  IELTS Workspace 的源码公开在{" "}
                  <a href={REPO} rel="noreferrer" target="_blank">
                    GitHub
                  </a>
                  。如果这个项目对你有用，点个 Star 是对作者最大的支持，也方便你跟踪新版本。
                </p>
              </div>
              <a className="btn btn-primary" href={REPO} rel="noreferrer" target="_blank">
                ⭐ 去 GitHub 点 Star
              </a>
            </article>
          </div>
        </section>

        <section id="listening" aria-labelledby="listening-title">
          <div className="wrap">
            <p className="kicker">Listening</p>
            <h2 id="listening-title">听力音频</h2>
            <p className="web-note">
              <strong>网页版无需本节：</strong>
              音频已随站点内置，进<a href="#/app">在线练习</a>直接听。以下是桌面版的音频包下载。
            </p>
            <ol className="steps">
              <li>打开桌面应用，进入听力资源中心，或在试卷行点「添加音频」。</li>
              <li>
                支持四个 Part/Section 文件（剑4–20）、文件夹与每册 ZIP；ZIP
                内的官方整轨按 SHA-256 自动识别。
              </li>
              <li>
                桌面应用不会在内部下载音频。点「打开下载指南」只会打开本页的这一节。
              </li>
            </ol>
            <p>
              分册压缩包来自 GitHub Release <code className="path">{AUDIO_TAG}</code>
              ，C04 到 C20。每行是册名和 ZIP 文件名。
            </p>
            <ul className="books">
              {BOOKS.map((book) => (
                <li key={book.id}>
                  <span className="book-name">{book.name}</span>
                  <code className="path">{book.file}</code>
                  <a href={book.href}>下载 ZIP</a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="data" aria-labelledby="data-title">
          <div className="wrap">
            <p className="kicker">Data</p>
            <h2 id="data-title">数据目录</h2>
            <p>会话、笔记和高亮都在本机。换电脑时拷走对应目录即可。</p>
            <dl className="data-list">
              <div>
                <dt>网页版</dt>
                <dd>
                  <code className="path">浏览器 IndexedDB（ielts-workspace 库）</code>
                </dd>
              </div>
              <div>
                <dt>安装版</dt>
                <dd>
                  <code className="path">%LOCALAPPDATA%\IELTS Workspace User Data\data</code>
                </dd>
              </div>
              <div>
                <dt>便携版</dt>
                <dd>
                  <code className="path">&lt;EXE目录&gt;\data</code>
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="wrap">
          <p>
            <a href={`${REPO}/blob/main/LICENSE`} rel="noreferrer">
              MIT
            </a>
            {" · "}
            <a href={REPO} rel="noreferrer" target="_blank">
              GitHub 仓库
            </a>
          </p>
          <p>题库整理供个人学习，请支持正版剑桥教材。</p>
        </div>
      </footer>
    </>
  );
}
