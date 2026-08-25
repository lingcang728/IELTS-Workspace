const INSTALLER =
  "https://github.com/lingcang728/IELTS-Workspace/releases/latest/download/IELTS_Workspace_1.3.0_x64-setup.exe";
const PORTABLE =
  "https://github.com/lingcang728/IELTS-Workspace/releases/latest/download/IELTS_Workspace_1.3.0_x64.exe";
const REPO = "https://github.com/lingcang728/IELTS-Workspace";
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

export default function App() {
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
            <p className="kicker">Windows · 本地优先</p>
            <h1 id="hero-title">IELTS Workspace</h1>
            <p className="lede">本地优先的雅思机考工作台。</p>
            <p className="sub">
              Reading 与 Writing 开箱即用。Listening 试卷可见，音频由你自行添加。不内置
              AI，无遥测，除更新检查外不联网。
            </p>
            <p className="cta-row">
              <a className="btn btn-primary" href={INSTALLER}>
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
              IELTS Workspace 是跑在本机上的雅思 Academic 机考工作台。练习、Mock
              模考、划线笔记和交卷复盘都写在本地，不为刷题平台做账号或广告。
            </p>
            <ul className="facts">
              <li>
                <h3>Reading / Writing</h3>
                <p>开箱即用。题库随应用提供，打开即可按模块练习或按套卷模考。</p>
              </li>
              <li>
                <h3>Listening</h3>
                <p>
                  试卷在练习中心可见，音频需自行添加。应用不会在内部下载音频。点「打开下载指南」只会打开本页。
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
            <p>Windows 10 / 11 x64。安装版支持应用内更新，便携版可整夹拷走。</p>
            <div className="dl-grid">
              <article className="dl-card">
                <p className="badge">推荐</p>
                <h3>安装版</h3>
                <p className="file">IELTS_Workspace_1.3.0_x64-setup.exe</p>
                <p>
                  安装到本机，数据写在{" "}
                  <code className="path">%LOCALAPPDATA%\IELTS Workspace\data</code>。
                </p>
                <a className="btn btn-primary" href={INSTALLER}>
                  下载安装版
                </a>
              </article>
              <article className="dl-card">
                <p className="badge badge-quiet">绿色</p>
                <h3>便携版</h3>
                <p className="file">IELTS_Workspace_1.3.0_x64.exe</p>
                <p>
                  单文件运行，数据写在 <code className="path">&lt;EXE目录&gt;\data</code>。
                </p>
                <a className="btn btn-secondary" href={PORTABLE}>
                  下载便携版
                </a>
              </article>
            </div>
          </div>
        </section>

        <section id="listening" aria-labelledby="listening-title">
          <div className="wrap">
            <p className="kicker">Listening</p>
            <h2 id="listening-title">听力音频</h2>
            <ol className="steps">
              <li>打开应用，进入听力资源中心，或在试卷行点「添加音频」。</li>
              <li>支持整轨 mp3 / m4a / wav、四个 Part、文件夹，以及每册 ZIP。</li>
              <li>
                应用不会在内部下载音频。点「打开下载指南」只会打开本页的这一节。
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
                <dt>安装版</dt>
                <dd>
                  <code className="path">%LOCALAPPDATA%\IELTS Workspace\data</code>
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
