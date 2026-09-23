# IELTS Workspace Web V2 — 并行开发契约

目标：把 `site/` 从官网升级为**浏览器内可用的雅思工作台**（对标虾滑听力/ZYZ PASSAGE 的第一屏学习体验）。桌面端参考实现都在 `../src/`（Tauri 版），视觉与逻辑尽量复刻，数据层已替换为 IndexedDB。

## 硬规则（违反 = 返工）

1. **只改自己名下的文件**。需要改公共文件时，在自己的文件里绕开，不要动别人的。
2. UI 文案一律**简体中文**。
3. **不显示假数据**：统计/热力图/正确率只能来自 IndexedDB 里真实 session/mistake/vocab 记录；没有数据显示 `—` 或空状态。
4. Band 分只能查表：`lib/band.ts` 的 `rawToBand`/`bandLabel`/`rawNeededForBand`（表在 `lib/band-conversion.json`）。
5. **考场视觉域隔离**：`app/styles/exam.css` 只能用 `--exam-*` token，固定浅色官方风，不跟随外壳主题。App 外壳用 `tokens.css`/`shell.css` 变量。
6. 不接任何 AI/网络 API；不新增 npm 依赖（agent5 可用 `jszip`，已在 package.json 加好则直接用，没有就先 `npm i jszip@^3.10.1`）。
7. TypeScript strict + noUnusedLocals：写完跑 `cd site && npx tsc --noEmit` 必须过（暂以你的文件为准，别人文件报错先忽略）。
8. 参考实现：`../src/pages/*.tsx`、`../src/components/*.tsx`、`../src/exam/*`、`../src/styles/*`。移植时把 `../lib/api` 换成 `../api`，`../lib/x` 换成 `../lib/x`（已复制）。

## 数据层（已写好，直接用）

`site/src/app/` 下：

- `types.ts` — 与桌面端 `src/lib/types.ts` 完全一致的契约（Exam/Session/ScoreReport/Mistake/VocabCard/StudyPlan/Profile…）
- `api.ts` — Web 版 API，函数签名与桌面 `src/lib/api.ts` 相同：`bootstrap() listExams() loadExam(id) saveSession(s) loadSession(id) listSessions() discardSession(id) archiveSession(id) scoreExam(examId, answers) importExam(json) loadProfile() saveProfile(p) mistakeAdd/List/Resolve/Delete vocabAdd/List/Due/Review/Delete planGet/Save feedbackSave/List/Delete loadTranscript(examId) assetSrc(rel) playbackSourceFor(exam) saveBlob(rel, blob) analyticsReport(rangeDays)`
- `content.ts` — `contentIndex()` 返回 `{exams: IndexedExam[]}`；IndexedExam 比 ExamSummary 多 `book/test/partLabels/questionTypes/meta(frequency/difficulty/tags)`。试卷 JSON 在 `/content/exams/<id>.json`，图片在 `/content/assets/cambridge/*.jpg`。
- `scoring.ts` — `scoreExam(exam, answers): ScoreReport`，与 Rust 版同规则（trim/空白折叠/小写；`in_either_order` 组去重匹配；答案可以是原始值或 `{value}` 的 AnswerEntry）。
- `analytics.ts` — `analyticsReport(rangeDays)`，已提交的 session 全部重新评分。
- `nav.ts` — `useRoute() navigate(path, query) href(path, query)`；路由 `#/app/...`，`route.segments[1]` 是页名，`route.query` 是 URLSearchParams。
- `lib/` — 从桌面端复制的纯函数库：`band catalog choice dictation examRuntime format highlight mistakes plan promptStudio quotes reviewPrompt srs unicode view closeFlush`。
- `idb.ts` — `idbGet/idbSet/idbDel/idbKeys/idbAll(store, ...)`；store 名：`kv sessions exams blobs transcripts`。

## 路由（已定，不许改）

| hash | 页面 | 文件负责人 |
|---|---|---|
| `#/` | 官网落地页 | agent6 App.tsx |
| `#/app` | 今日工作台 | agent2 Today.tsx |
| `#/app/library` | 题库 | agent3 Library.tsx |
| `#/app/exam?exam=<id>&mode=mock|practice&session=<id>` | 考场（全屏无壳） | agent4 ExamPage.tsx + exam/ |
| `#/app/results?session=<id>` | 成绩复盘 | agent5 ResultsPage.tsx |
| `#/app/analytics` `#/app/history` `#/app/mistakes` `#/app/vocab` | 分析/历史/错题/生词 | agent5 |
| `#/app/settings` | 设置 | agent5 |

页面组件签名：`export default function Xxx({ route }: { route: Route })`（Today 可无参）。已在 `routes.tsx` 接好。

## 音频模型

- 听力试卷 `section.audioAsset` 指向 `assets/cambridge/cNN-tM.mp3`（整轨），各 part 用 `audioStartMs/audioDurationMs` 定位——与桌面一致。
- mp3 直接打包进 `site/public/content/assets/cambridge/`（CI 在构建前从 `listening-audio-v1` release zip 还原，见 `.github/workflows/pages.yml`）；本地开发用 `python scripts/restore_site_audio.py` 复原。
- 播放源优先级：IndexedDB `blobs`（自组卷/覆盖）→ `/content/<rel>`（打包）→ GitHub release 单文件 URL（`remoteAudioSrc`，仅在打包路径 404 时由 ExamApp 的 onError 重试）。`<audio>` 跨域播放不需要 CORS。
- 索引的 `audioStatus` 由构建期文件存在性决定；运行时 `content.ts` 仍会把「缺失但远端/IDB 有」的卷升级为 ready。

## 视觉

- 外壳/工作台/题库等：复用 `app/styles/tokens.css + shell.css + practice.css`（已从桌面复制，class 名一致：`.workspace-card .page-stack .primary-button .secondary-button .meta .empty-state .notice-strip .select-field .button-row .chip` 等）。外壳配色保留桌面深色/浅色双主题能力，默认浅色。
- 官网落地页：保留现有米白+朱砂 editorial 风（`src/styles.css`），加一个显眼的「在线练习 / 进入工作台」入口。
- 手机端：今日/生词/错题/历史可用；进 `#/app/exam` 时窄屏显示「推荐使用 ≥11 英寸屏幕」提示条，不强行做双栏。

## 试卷生命周期（与桌面一致）

Session: `schemaVersion:1, id(随机), examId, examRevision, examTitle, module, mode, status:"created"|"in_progress"|"submitted"|"aborted"|"interrupted", integrity:"clean"|"interrupted", startedAt, updatedAt, remainingMs, answers:{qid:AnswerEntry}, highlights[], notes[], events[], audio?, writing?, fontScale?`。

提交后：`scoreExam` → 存 session(status:"submitted") → `mistakesFromReport`（lib/mistakes.ts）→ `mistakeAdd` → 跳 `#/app/results?session=<id>`。
