# AGENTS.md — 本仓库的硬纪律

给所有在这个仓库里工作的人和 agent。`CLAUDE.md` 讲的是**架构怎么回事**，这份讲的是**什么绝对不许做**。

---

## 1. 发布纪律：改完必重新打包，新包出来旧包立刻删

> **每次改完代码并确认完成后，必须立即重新构建、打包，替换 `release/` 下的旧安装包与便携版，绝不只改代码不打包。**
> 安装包只放仓库根目录 `release/`，且**只保留当前最新打包产物**。禁止再写 `output/release/`。

原因：改完代码若不重新打包，本地快捷方式和磁盘上运行的就永远是旧版本；两个版本的 exe 同时躺在磁盘上也会造成版本混淆。

执行顺序：

1. `npm run package:release` 产出新包到 `release/`（setup.exe、便携 exe、`latest.json`，并自动更新桌面与开始菜单快捷方式）。
2. 亲自跑一次新包（安装版 + 便携版各一次），确认能启动、能进考场、能交卷。
3. **确认通过后，`release/` 里只应剩下最新这一版。** 旧版立刻删。
4. GitHub Releases 已经是历史归档；`release/*.exe` 不进 git。

---

## 2. 版本号四处一致

版本出现在四个地方，**必须完全相同**，`package-release.ps1` 和 CI 都会在不一致时直接失败：

| 位置 | 字段 |
|---|---|
| `package.json` | `version` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/tauri.conf.json` | `version` |
| git tag | `v<version>`，例如 `v1.1.0` |

改版本号时四个一起改，不要只改一个然后指望别人发现。

---

## 3. 发布前必须跑 `.\verify.ps1`

不是 `npm test`，是 `.\verify.ps1`。它包含：

```
verify_cambridge.py --baseline --health   # 题库结构 + 损坏比 ratchet
npm test                                  # vitest
cargo test --manifest-path src-tauri/...  # Rust
npx tsc --noEmit                          # 类型
npm run build                             # 生产构建
```

`fixtures/cambridge/` 不存在时（CI、全新 clone）第一步自动跳过，其余照跑。

### 题库损坏 ratchet

`fixtures/cambridge-health-baseline.json` 记录当前"必须修复"的题目数。规则只有一条：

> **这个数字只能降，不能升。**

- 结构性问题（文件缺失、JSON 坏、音频缺失、题号不是 1–40）**永远直接失败**，不走 ratchet。
- 单题内容损坏（占位符 prompt、同卷 prompt 重复、转录切片、选项字母答案配错题型）与 baseline 比较，**一旦变多就红**。
- 修好题之后跑 `python scripts/verify_cambridge.py --baseline --update-baseline` 把 baseline 压低，并把这个文件一起提交。
- **不许**为了让构建变绿而调高 baseline。

看进度用 `python scripts/verify_cambridge.py --baseline --health`，会打印各册各模块的健康度表。

---

## 4. 题库修复：overlay 永远不被脚本覆盖

题库修复走 `scripts/repair/` 管线，合并优先级是：

```
fixtures/overlays/{exam-id}.json   （人工，最高）
  > data-dev/repair/parsed/…       （自动解析）
    > 现有 fixtures/cambridge/…    （最低）
```

> **任何自动脚本都不得写入或覆盖 `fixtures/overlays/`。**

这是能反复重跑解析器的**唯一**前提。人工审阅的成本是以小时计的；一次误覆盖就等于把那些小时扔了。解析器可以随便重跑、随便改规则，只要它不碰 overlay。

`overlays` 里 `status` 的含义：

- `approved` — 看过了，自动解析的结果是对的
- `corrected` — 人工改过
- `flagged` — 存疑，待查原书

---

## 5. Git LFS 文件类型清单

以下类型走 LFS，不许直接提交进 git 对象库：

```
*.mp3   *.m4a   *.wav   *.pdf
```

对应 `.gitattributes`。新增大体积二进制类型时，先加 `.gitattributes` 再提交，顺序反了就得重写历史。

日常开发不需要真的下载这些文件：

```powershell
$env:GIT_LFS_SKIP_SMUDGE=1; git clone <url>
```

GitHub Free/Pro 的 LFS 配额是 10 GiB 存储 + 10 GiB/月流量；当前媒体总量约 2.78 GB，一次完整 clone 就吃掉约四分之一月流量，所以不要养成反复 full clone 的习惯。

---

## 6. 不显示假数据

这条是产品纪律，也是代码纪律。

- 进度条、百分比、平均分、趋势线，**只能来自真实测量值**。
- 没有数据就显示 `—` 或空状态，**不要**用 `length * 12` 这类公式编一个看起来合理的数字。
- Band 分数只能来自 `schema/band-conversion.json` 的查表，**永远不要**写 `raw / total * 9`。前端走 `src/lib/band.ts`，Rust 走 `src-tauri/src/band.rs`（`include_str!` 同一个文件）。
- 任何"看起来像控件但点不动"的元素（假 `<select>`、假 tab）都算 bug。

备考决策要靠这些数字。显示一个编出来的平均分，比什么都不显示更糟。

---

## 7. 两个视觉域不许互相污染

| 域 | 范围 | 规则 |
|---|---|---|
| **App 外壳** | 工作台 / 练习 / 模考 / 分析 / 历史 / 设置 | kami 纸感暖色，深浅双模式 |
| **考场 Runtime** | 答题界面 | **固定浅色官方风**，不跟随主题 |

`src/styles/exam.css` **只准**读 `--exam-*` token。里面出现一个 `var(--blue)` 或 `var(--ink)`，考场就会跟着外壳变深色——这正是它之前跑偏的方式。

考场行为以 `docs/ui-reference.md` 为准，那份文档标了日期和官方来源。**要改考场行为，先改文档和它引用的来源。**

---

## 8. 不接内置 AI

软件只负责**生成高质量 prompt**，用户复制到自己已订阅的 ChatGPT / Gemini / Grok / Claude 网页端。

不要提议接入 OpenAI API、不要提议内置本地 7B 模型、不要加"AI 批改"按钮然后偷偷调云端。理由已经想清楚了：自建 API 对开发者太贵且把用户框死在内定模型里；云端大模型有最新信息和联网搜索；本地小模型效果差。复用用户已有订阅既省钱又更自由。

同理，CSP 在 `tauri.conf.json` 里挡掉了所有远程脚本：**除更新检查端点外，不发任何网络请求**，没有遥测。

---

## 9. 语言

UI 文案、错误信息（含 Rust `AppError` 文本）、commit message 一律**简体中文**。代码注释和本文件这类工程文档可以中英混排。
