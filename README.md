# IELTS Workspace

IELTS Workspace 是一个本地优先的 IELTS Academic 练习与模考桌面端，使用 React、TypeScript、Rust 和 Tauri 构建。

- 管理界面为中文，考试界面为英文。
- 支持 Reading、Listening、Writing、严格计时、答题导航、标记、笔记和本地分析。
- Practice 可暂停；Mock 按考试规则限制暂停、音频重播和拖动。
- 所有会话、设置和笔记保存在本机，不依赖云端账户，也不内置 AI 评分。

## 开发与验证

```powershell
npm ci
npm run tauri dev
npm run verify
```

本机已有 Playwright 时请复用已有运行时和浏览器缓存，不要在项目中重复安装。

## 内容与版权边界

仓库只包含项目原创的最小渲染器 fixture。Cambridge IELTS 教材、试题、答案和录音不在仓库中，也不会由构建脚本下载。使用者只能导入自己合法取得、并有权使用的本地材料。

- `fixtures/question-types`：原创的渲染与评分测试数据。
- `听力/manifest.csv`：项目所有者本机音频的文件清单与校验值，不含音频。
- `教材/manifest.csv`：项目所有者本机教材的文件清单与校验值，不含 PDF。

Cambridge 官方版权声明和权限说明：

- <https://www.cambridge.org/rights-and-permissions>
- <https://assets.cambridge.org/97810094/54735/frontmatter/9781009454735_frontmatter.pdf>

## 本地数据

运行时数据位于程序目录旁的 `data` 中，其中 `sessions` 是不可再生的考试记录。迁移或更新前请备份整个 `data` 目录。
