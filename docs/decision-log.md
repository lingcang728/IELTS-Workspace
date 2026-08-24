# 决策记录（原 plan.md）

> **状态：历史决策记录，不是当前待办清单。**
>
> 这份文档是项目开工前写下的最终实施计划，记录了**为什么**做出各项技术决定
> ——便携原则、数据目录分层、Schema 与判分契约、Mock/Practice 政策、Session
> 持久化与 Highlight 的 Unicode 规则等。这些「为什么」在代码里看不出来，所以
> 原样保留下来。
>
> 当它与下列文档冲突时，**以下列文档为准**：
>
> | 主题 | 现行来源 |
> |---|---|
> | 架构与 IPC 边界 | `CLAUDE.md` |
> | 工程与发布纪律 | `AGENTS.md` |
> | 考场行为（含官方来源与日期） | `docs/ui-reference.md` |
> | 数据结构 | `docs/schema.md` |
> | 当前修复计划与排期 | `IELTS-Workspace-修复计划.md`（工作区外） |
>
> 文中第 32–36 节描述的「AI Learning Layer」已被推翻：软件**不接内置 AI**，
> 只生成 prompt 供用户复制到自己已订阅的模型（理由见 `AGENTS.md` 第 8 条）。

---

# IELTS Workspace — 最终实施计划

## 1. 项目定位

IELTS Workspace 是一个：

- 本地运行
- 便携免安装
- 面向 IELTS Academic
- 高度还原真实电脑机考行为
- 可以长期积累个人练习数据
- 后期能够接入 AI 辅助训练

的桌面工作台。

第一阶段的价值不是“做一个雅思题库网站”，而是做一个真正能够坐下来完成完整 Mock 的本地考试运行环境。

每个阶段都必须产出可以真实用于备考的成果，禁止长期只建设基础设施而无法练题。

---

## 2. 不可变技术约束

### 2.1 技术形态

- Tauri 2 桌面应用。
- Windows 为当前主要目标平台。
- 提供便携版，免安装。
- 软件与用户数据尽可能集中在同一个项目目录内。

Release 模式：

```text
IELTS-Workspace/
├── IELTS Workspace.exe
├── data/
└── ...
```

所有运行数据必须以：

```rust
current_exe()
```

返回的 exe 所在目录为根解析。

**禁止依赖 cwd。**

原因是便携程序在快捷方式、终端、Explorer、更新器或其他启动环境下的 cwd 不可靠。

Dev 模式使用项目内部单独的数据目录，例如：

```text
IELTS-Workspace/
├── src/
├── src-tauri/
├── data-dev/
├── fixtures/
├── schema/
└── data-example/
```

### 2.2 Git 边界

以下目录不得进入 Git：

- `data/`
- `data-dev/`
- 用户正版 Cambridge IELTS PDF
- 用户音频
- 官方 Sample 的本地完整副本
- Session
- 个人学习记录
- AI 分析结果
- 用户笔记

Git 中可以保留：

- `schema/`
- `fixtures/`
- `data-example/`
- 自己编写的小型假题
- 测试数据
- 不涉及版权内容的示例资产

### 2.3 便携原则

目标语义：

- 删除整个 IELTS Workspace 文件夹 = 清理干净
- 拷贝整个文件夹到另一块硬盘 = 完成迁移
- 不得悄悄把核心用户数据写入 AppData
- 不得在便携目录不可写时静默降级到其他位置

---

## 3. 数据目录建议

目录名字可以由 Coding Agent微调，但语义应保持清晰。

```text
data/
├── sources/
├── library/
├── assets/
├── sessions/
├── profile/
├── notes/
├── cache/
└── temp/
```

### 用户不可再生数据

```text
sessions/
profile/
notes/
```

必须优先保证安全。

### 来源数据

```text
sources/
```

包括用户自己的 PDF、音频及其他原始资料。

### 标准化数据

```text
library/
assets/
```

由 Importer 产生，理论上可以重新生成。

### 可再生数据

```text
cache/
temp/
```

可以安全删除并重建。

未来可支持：

- 完整备份
- 仅个人学习记录备份

---

# 4. UI 与真实 IELTS 机考参考策略

Coding Agent 在实现考试 UI 前，必须自行联网调查当前真实 IELTS Academic 电脑机考环境，再据此设计和实现。

目标是理解真实考试的：

- 页面布局
- 顶部信息区域
- 计时器
- Passage / Questions 布局
- Question Navigator
- Review / Flag 行为
- Highlight
- Notes
- 字体与可访问性设置
- 提交流程
- 时间提醒
- Listening 播放行为
- Writing 编辑环境
- 各类题型的真实交互方式

## 4.1 参考资料优先级

优先搜索和使用：

1. IELTS 官方当前资料
2. British Council 当前 IELTS on Computer / familiarisation test
3. IDP 当前 IELTS on Computer / practice / familiarisation materials
4. 官方视频、官方截图、官方帮助文档
5. 官方无法覆盖的视觉细节，可参考公开考试演示、可信 walkthrough 视频或截图
6. 博客和论坛只能做辅助，不得覆盖官方规则

重点参考**当前有效**资料，避免拿过时的旧版机考界面直接复刻。

如果不同来源显示的界面存在差异：

- 优先当前官方资料
- 优先与用户将参加的普通 IELTS Academic 机考环境更接近的资料
- 将无法确认的差异记录下来
- 不凭模型记忆自行发明行为

## 4.2 UI 调研产物

在正式做 Reading Runtime 的视觉和交互 polish 前，Coding Agent 应形成一份简短的本地参考记录，例如：

```text
docs/ui-reference.md
```

内容包括：

- 参考网址
- 访问日期
- 核心截图/页面说明（在合理合法范围内）
- 已确认交互
- 未确认交互
- 实现取舍

这份文档用于后续验收“是否接近真实机考”。

## 4.3 还原原则

优先级：

**行为还原 > 操作肌肉记忆 > 信息布局 > 视觉接近 > 像素级复制**

无需为了 1 px 的颜色或边距差异拖慢开发。

真正重要的是：

- 用户在哪里看时间
- 如何跳题
- 如何 Review
- 如何 Highlight
- 如何写 Note
- Passage 与题目如何滚动
- 答案如何填写
- 到时如何结束
- Listening 是否能回放
- Writing 是否有考试中不存在的辅助功能

任何真实考试行为不确定时，先查资料，再实现。

---

# 5. 总体架构

项目分为三层。

## 5.1 Exam Runtime

负责考试本身运行：

- Session 生命周期
- Answer State
- Timer / End Condition
- Navigation
- Review
- Highlight / Notes
- Persistence
- Submit
- Recovery
- Mock / Practice Policy
- Module-specific policy hooks

Exam Runtime：

- 不解析 PDF
- 不认识 Cambridge
- 不依赖 AI
- 不把 Reading 写死进核心状态机

## 5.2 Content / Importer

负责将不同来源内容转换为统一 Exam Schema：

- 官方免费样题
- Cambridge IELTS
- 用户导入 PDF / Markdown
- 音频
- 图片
- 未来 AI 生成练习

## 5.3 AI Learning Layer

建立在前两层产生的真实 Session 数据之上：

- Reading 错题解释
- 弱项分析
- 题型统计
- Passage 用时分析
- Writing 反馈
- Speaking 训练
- 每日练习
- 长期趋势

---

# 6. 内容抽象

不要让 `Book` 成为整个系统的根节点。

建议逻辑结构：

```text
Source
├── official_sample
├── cambridge_book
├── imported_document
└── generated_practice
```

然后统一进入：

```text
Exam
└── Module
    └── Section / Passage / Task
        └── QuestionGroup
            └── Question
```

Module 目前考虑：

```text
Reading
Listening
Writing
Speaking
```

`QuestionGroup` 是必要实体，用于保存：

- Shared instruction
- Shared options
- word bank
- shared matching pool
- shared image
- 题号范围
- 组级判分策略
- 题型上下文

避免把共享内容复制进每道 Question。

---

# 7. Schema 基础要求

## 7.1 Schema 版本

每个 Exam JSON 顶层必须带：

```json
{
  "schemaVersion": 1
}
```

每个 Session JSON 顶层同样必须带：

```json
{
  "schemaVersion": 1
}
```

未来修改结构时允许迁移旧数据。

---

## 7.2 Question Type

Question 必须使用 discriminated union。

具体最终拆成多少种由 Coding Agent根据真实 IELTS 题型和 Renderer 复用关系决定。

必须覆盖当前 IELTS 中稳定存在的主要交互类型，例如：

- 单选
- 多选
- True / False / Not Given
- Yes / No / Not Given
- Sentence Completion
- Summary Completion
- Note Completion
- Form Completion
- Table Completion
- Flow-chart Completion
- Short Answer
- Matching Headings
- Matching Information
- Matching Features
- Matching Sentence Endings
- Diagram Labelling
- Map / Plan Labelling

不要为了“一种官方题型 = 一个组件”而制造大量重复 Renderer。

相同交互逻辑可以共享组件。

---

# 8. Answer Key 与 Scoring Engine

这是核心可信度模块。

## 8.1 多可接受答案

Answer Key 不允许只存一个字符串。

示意：

```json
{
  "acceptedAnswers": [
    "colour",
    "color"
  ]
}
```

判分前执行基础 normalization：

- trim 首尾空格
- 忽略大小写
- 折叠连续空格

其他合法变化，例如：

- colour / color
- 20 / twenty
- 带或不带特定连字符
- 官方允许的可选词

应由 Importer 展开为**显式 acceptedAnswers**。

判分器本身不进行宽泛模糊猜测。

例如官方 Answer Key：

```text
(the) library
```

Importer 应转成：

```json
[
  "library",
  "the library"
]
```

判分器不负责解析括号语法。

---

## 8.2 QuestionGroup 级判分

`acceptedAnswers` 只能表达单题规则，还需要支持组级规则。

典型 IELTS 场景：

```text
Choose TWO letters, Questions 21–22
```

如果正确答案为 B、D：

- Q21=B, Q22=D → 2 分
- Q21=D, Q22=B → 2 分
- Q21=B, Q22=B → 不得按两题都正确计算
- 只选中一个正确项 → 按官方题目对应规则给分

QuestionGroup 增加类似：

```text
scoringPolicy
```

首版至少支持：

```text
per_question
in_either_order
```

Scoring Engine 遇到 `in_either_order`：

- 先归组
- 去重
- 再计分

必须有单元测试覆盖：

- 正序
- 逆序
- 重复
- 部分正确

---

# 9. Runtime 模块无关原则

Runtime 只负责：

```text
Exam
Session
Answer
End Condition
Navigation
Review
Persistence
Submit
Recovery
Policy
```

禁止核心代码出现类似：

```text
if module == Reading:
    timer = 60 minutes
```

模块规则必须通过配置或 Policy 注入。

---

# 10. End Condition

第一天就把“何时结束考试”抽象出来。

Milestone 1 只实现固定时长，但接口要能覆盖后续模块。

例如：

## fixed_duration

用于：

- Reading
- Writing

## media_driven

用于 Listening：

```text
音频播放进度
→ 音频结束
→ 官方规则对应的检查阶段
→ 强制结束
```

实际 Listening 当前机考规则、检查时间和交互必须由 Coding Agent 在实现时查询当前官方资料确认，禁止仅根据旧资料或模型记忆写死。

---

# 11. Mock / Practice Policy

Mock 和 Practice 使用**同一个 Runtime**。

禁止建立：

```text
MockRuntime
PracticeRuntime
```

两套实现。

区别由 Policy 控制，例如：

```text
pauseAllowed
answerVisible
aiAllowed
forceSubmit
audioSeekAllowed
strictNavigation
```

Practice 在 media-driven 模式下如果允许暂停：

- 暂停考试计时
- 同时暂停音频
- 恢复后从原位置继续

Mock 必须遵循当前真实考试规则。

---

# 12. Session 与 AI 前向契约

Session 从 Milestone 1 就要保存未来 AI 分析所需要的最小信息。

每条 answer 至少保留：

- 稳定 `questionId`
- `questionType` 快照
- 用户答案
- 必要状态

不要只存“第 7 题”这样的纯索引。

Session 还需要一个轻量事件日志。

至少记录：

- 当前 Question / Passage / 区域切换时间
- Submit 时间

无需做：

- 键盘级埋点
- 鼠标轨迹
- 过细行为日志

目标是未来可以推断：

- Passage 用时
- 题型正确率
- 哪类题经常卡住
- 整体时间分配

这个契约视为 Runtime 与 AI Layer 之间的关键前向依赖。

---

# 13. Session 生命周期

至少支持：

```text
created
in_progress
submitted
aborted
interrupted / recoverable
```

应用重新打开时，如果检测到未结束 Session：

```text
Previous session was interrupted.

Continue
Discard
Archive
```

异常恢复后的严格 Mock 应标记，例如：

```text
integrity = interrupted
```

避免把它误认为完整无中断 Mock。

---

# 14. Session 持久化

每次答案发生变化，在逻辑上立即进入持久化队列。

具体实现由 Coding Agent 自主决定，例如：

- debounce
- write queue
- temp file
- atomic rename
- snapshot

验收要求：

- 任意时刻强制杀进程，Session 文件不能整体损坏
- 重启后最多损失极短窗口内输入
- 前端 answer state 与磁盘不能长期不同步
- 写入错误不得被吞掉

---

# 15. 启动数据目录自检

程序启动时：

1. 通过 `current_exe()` 获得根目录
2. 定位 `data/`
3. 创建探针文件
4. 写入内容
5. 删除探针文件

如果失败：

必须明确显示中文提示，例如：

> 当前目录不可写，IELTS Workspace 无法安全保存考试数据。请将整个程序文件夹移动到可写目录后重新启动。

并阻止进入考试。

禁止自动改写到：

- AppData
- Temp
- Documents
- 其他隐藏目录

典型风险：

- Program Files
- 只读磁盘
- 权限异常
- 网盘/同步软件锁文件
- 磁盘满

对于 OneDrive 等同步目录，如果无法可靠自动判断，可以提示潜在风险，不需要过度工程化。

---

# 16. 运行期间写入失败

启动探针不能覆盖运行中所有失败。

考试过程中如果 Session 写入失败：

- 立即显示明显但尽量不打断答题的持久化警告
- 明确告诉用户答案可能尚未安全保存
- 后台持续重试
- 写入恢复后可以解除警告
- 禁止 silently ignore

Windows 打包时启用 long-path-aware manifest。

需验证深层中文路径和长路径场景。

---

# 17. Highlight

Highlight 是 Reading 核心功能，也是高返工风险区域。

禁止存：

- DOM Node
- DOM Range
- XPath
- 临时 HTMLElement 引用

使用：

```text
Normalized Text + Character Offset
```

流程：

```text
Source
→ Parsed Content
→ Normalized Text
→ Render
```

---

## 17.1 Unicode 规则

Normalized Text 先进行：

```text
Unicode NFC normalization
```

offset 单位固定：

```text
unicode_code_point
```

不得用 JS 默认 UTF-16 code unit 语义作为存储标准。

前端实现时要显式处理这一差异。

---

## 17.2 Highlight 存储

每条至少记录：

```text
targetId
startOffset
endOffset
offsetUnit = unicode_code_point
textHash
contextBefore
contextAfter
```

Hash 固定：

```text
SHA-256(
  UTF-8(
    NFC(normalizedText)
  )
)
```

该规则应写入 Schema 注释或技术文档。

---

## 17.3 单层原则

所有：

- offset 计算
- NFC normalization
- text hash
- highlight recovery

只在**前端文本层**实现。

Rust：

- 不理解 offset
- 不重新计算 hash
- 不进行 Unicode 文本逻辑
- 只将 Highlight 当作不透明数据持久化

避免 JS / Rust 两套实现产生差异。

---

## 17.4 文本变化

恢复 Highlight 时：

1. 检查 textHash
2. 一致 → 按 offset 恢复
3. 不一致 → 用上下文片段尝试恢复
4. 无法可靠匹配 → 标记失效

禁止静默高亮到错误文字。

---

# 18. Notes

Notes 可以依附：

- Highlight
- Passage
- Question

第一阶段只需要考试场景的轻量 Note。

不要发展成：

- Obsidian
- Notion
- 知识管理系统

---

# 19. 必须存在的自动测试

项目无需一开始建立巨大测试体系。

以下两类必须测试。

## 19.1 Scoring Engine

覆盖至少：

- 大小写
- trim
- 连续空格
- 多 acceptedAnswers
- 单选
- 多选
- Matching
- Completion
- 判断题
- 非法答案
- `in_either_order` 正序
- `in_either_order` 逆序
- 重复项
- 部分正确

## 19.2 Highlight Offset / Recovery

覆盖至少：

- ASCII
- 中文
- 重音字符
- Unicode NFC
- 换行
- hash 一致
- hash 不一致
- 内容修改
- 上下文恢复成功
- 上下文恢复失败

其他测试由 Coding Agent根据收益自主决定。

---

# 20. 第一阶段：Exam Runtime

目标：

最终得到可以真实用于 IELTS Academic 日常练习的：

- Reading Mock
- Listening Mock
- Writing Mock

第一阶段按三个里程碑推进。

不存在固定“几周完成”的时间限制。

每个 Milestone 一旦满足验收条件，就立刻进入下一阶段。

---

# 21. Milestone 1：Reading Mock

这是开工后的第一目标。

验收主流程：

```text
双击 portable exe
→ 中文管理界面
→ 选择官方 Academic Reading Sample
→ Start
→ 全英文考试界面
→ 完成 Reading
→ Submit
→ Raw Score
```

必须具备：

- Passage / Questions 双栏
- 两侧独立滚动
- 1–40 Question Navigator
- 已答 / 未答状态
- Review 标记
- Highlight
- Notes
- 固定时长倒计时
- 当前官方规则对应的时间提醒
- 手动 Submit 确认
- 到时强制 Submit
- Session 自动保存
- 崩溃恢复
- Raw Score
- QuestionGroup 组级判分

具体时间提醒、导航位置、Review 表现、Highlight / Notes 入口等 UI 行为必须以 Coding Agent 的当前网上调查结果为准。

---

# 22. Milestone 1 的真实官方 Sample 内容任务

Importer 属于第二阶段，但 Reading Mock 必须有真实内容。

因此 Milestone 1 内允许：

- 手工写 Exam JSON
- 编写一次性转换脚本
- 手工修数据

将至少一套当前可公开访问的官方 Academic Reading Sample 转为本地 Exam Schema。

建议开发态放在：

```text
data-dev/official-samples/
```

这份内容用于：

- Schema 第一次真实压力验证
- Question Renderer 真实验证
- Reading Runtime 验收
- UI 与当前官方题型环境对照

但此时**禁止顺手开发**：

- 通用 PDF Parser
- 通用 Importer framework
- Import Review UI
- Cambridge 自动解析器

这些属于第二阶段。

Git 中仍需另有：

```text
fixtures/question-types/
```

用自己编写的小型假题验证每种 Renderer。

---

# 23. Reading Mock 验收清单

## 启动与主流程

- [ ] 双击 Release portable exe 正常启动
- [ ] `current_exe()` 数据路径正确
- [ ] 中文管理界面可选择官方 Academic Reading 样题
- [ ] Start 后进入全英文考试环境
- [ ] Passage / Questions 双栏独立滚动
- [ ] Question Navigator 可用
- [ ] 已答 / 未答状态准确
- [ ] Review 可设置、取消并在导航中反映
- [ ] Highlight 可以添加、取消
- [ ] Notes 可以添加和查看
- [ ] 倒计时行为符合当前官方机考规则
- [ ] 时间提醒行为经过当前资料验证
- [ ] 到时强制提交
- [ ] 手动 Submit 有确认
- [ ] Submit 后 Raw Score 正确

## 数据安全

- [ ] 强制结束进程后 Session 文件未损坏
- [ ] 重启可 Continue / Discard / Archive
- [ ] 恢复后答案只允许损失极短写入窗口
- [ ] interrupted Mock 有 integrity 标记
- [ ] 只读 data/ 会在启动时阻止进入考试
- [ ] 运行时写入失败会显示警告并重试
- [ ] Session 含 schemaVersion
- [ ] Session 含稳定 questionId
- [ ] Session 含 questionType snapshot
- [ ] Session 含轻量事件时间戳

## Highlight

- [ ] Unicode code point offset 正确
- [ ] NFC 规则一致
- [ ] SHA-256 hash 校验正常
- [ ] 刷新后恢复正常
- [ ] Session 恢复后正常
- [ ] 内容变更时不会静默错位

## Scoring

- [ ] acceptedAnswers 生效
- [ ] 基础 normalization 生效
- [ ] QuestionGroup `in_either_order` 正确
- [ ] 单元测试通过

## UI 真实性

- [ ] Coding Agent 已自行完成当前 IELTS 机考 UI/行为资料调查
- [ ] 参考资料有记录
- [ ] 关键交互来自当前可信资料，而非模型记忆
- [ ] 用户完整坐下来完成一次 Mock 时，不明显感觉自己在使用开发 Demo

---

# 24. Milestone 2：Listening Mock

前提：

Reading Runtime 核心已经稳定。

新增：

- Audio Asset
- Audio State
- Playback Policy
- Part / Section
- media-driven End Condition
- Listening 题型
- Map / Plan 图片
- 相关导航状态
- 音频状态持久化

真实 Listening 行为由 Agent 在开发这一阶段时再次查当前官方资料确认。

重点包括：

- 音频是否只播放一次
- 能否暂停
- 能否 Seek
- Part 切换行为
- 音频结束后的检查阶段
- 考试结束条件
- 音量控制
- 题目导航

不得直接沿用旧纸笔考试规则。

---

## 24.1 本地资产

本地图片和音频通过适合 Tauri 2 的安全本地 asset 访问方案提供给前端。

需验证：

```text
D:\我的项目\IELTS Workspace\
G:\开发\雅思工具\
```

之类中文路径。

同时测试：

- URL encoding
- 空格
- Unicode 文件名
- 长路径

---

## 24.2 Listening 恢复

如果程序意外崩溃：

可以允许用户继续训练。

但恢复后的 Session：

```text
integrity = interrupted
```

不得视为严格无中断 Mock。

具体音频恢复策略由 Coding Agent在不破坏训练价值的前提下决定。

---

# 25. Milestone 3：Writing Mock

新增：

- Writing Task 1
- Writing Task 2
- Task 图片
- 纯文本编辑
- 字数统计
- fixed-duration End Condition
- Draft 自动持久化
- Submit

Coding Agent 实现前应查询当前 IELTS on Computer Writing 编辑器行为。

Mock 内禁止出现真实考试不存在的辅助：

- AI
- Rewrite
- 自动续写
- Grammar Assistant
- 智能润色
- 自动纠错
- 非真实考试提供的拼写辅助

目标是练习真正考试输入环境。

---

# 26. 第一阶段完成条件

当以下全部可以真实练习：

```text
Reading
Listening
Writing
```

第一阶段完成。

此时 IELTS Workspace 已经是一个可长期使用的本地 Academic LRW 机考模拟器。

---

# 27. 第二阶段：Content / Importer

目标：

让用户自己的正版资料进入 Runtime。

标准流程：

```text
PDF / Markdown / Audio
→ Existing Local Toolchain
→ Intermediate Content
→ IELTS Importer
→ Normalized Exam Schema
→ Exam Runtime
```

优先复用本机现有：

- DocToMarkdown
- opendataloader-pdf
- PyMuPDF
- RapidOCR
- Poppler
- Pandoc

不重新开发 OCR / PDF 基础设施。

---

# 28. 第一份 Cambridge Parser 样本

用户真正购买并获得哪一本 Cambridge IELTS Academic，就用哪一本。

不绑定：

```text
Cambridge 18
```

或其他册数。

第一版明确允许：

- 手工转一个 Test
- 手工编辑 JSON
- 手工清理 Markdown
- 手工关联图片
- 手工关联音频
- 手工确认 Answer Key

目标是首先验证：

```text
真实正版资料
→ Runtime
→ 可以完整练习
```

---

# 29. Importer 演进方式

推荐：

1. 手工完成一个真实 Test
2. 观察重复结构
3. 自动化稳定部分
4. 保留人工确认
5. 再扩到其他 Test
6. 再测试跨册兼容
7. 最后才考虑更通用导入

长期目标倾向：

```text
高自动化 + 少量明确人工确认
```

不要把目标设成：

```text
任意 PDF 100% 全自动魔法解析
```

解析准确性优先于自动化比例。

---

# 30. Import Review

Importer 成熟后可以增加：

```text
Import PDF

Detected:
4 Tests
Reading ✓
Writing ✓
Listening ✓
Images ✓

Review Import
```

用户可以确认：

- Test 边界
- Passage
- QuestionGroup
- Question Type
- Answer Key
- 图片绑定
- 音频绑定

如果自动解析不确定，宁可要求确认，也不要静默导入错误内容。

---

# 31. Library

Importer 稳定后建设 Library。

考试外管理界面使用中文。

功能包括：

- 浏览 Source
- 浏览 Exam
- 查看 Test
- 进入 Mock
- 进入 Practice
- 查看导入状态
- 管理本地内容

内容可以来自：

- 官方样题
- Cambridge IELTS
- 用户导入资料
- 自定义练习
- AI 生成练习

Runtime 始终只消费标准 Schema。

---

# 32. 第三阶段：AI Learning Layer

AI 层必须建立在真实 Session 数据上。

建议演进：

1. Reading 错题解释
2. 题型准确率
3. Passage 时间分析
4. Writing Review
5. Speaking
6. 个性化每日训练
7. 长期趋势与弱项分析

不要求预先绑定某一个模型供应商。

---

# 33. Reading Tutor

AI 输入可以包含：

- Passage
- QuestionGroup
- Question
- 用户答案
- Accepted Answer
- Session Context

输出重点：

- 为什么错
- 证据在哪里
- 属于语言理解问题还是考试策略问题
- 同类题应该怎么处理
- 是否属于重复出现的弱项

长期可以形成：

```text
Matching Headings: 58%
T/F/NG: 86%
Summary Completion: 79%
```

并结合：

```text
Passage 1: 16m
Passage 2: 20m
Passage 3: 27m
```

进行针对性分析。

---

# 34. Writing Coach

支持：

- Task Achievement / Task Response
- Coherence & Cohesion
- Lexical Resource
- Grammatical Range / Accuracy
- 段落反馈
- 改进建议
- Estimated Band

所有 AI 分数明确标：

```text
Estimated
```

不得让 UI 暗示它是官方 IELTS 成绩。

Band 换算规则保持数据化，例如独立 JSON，而不散落在 UI 逻辑中。

---

# 35. Speaking

后期再加入。

基本流程：

```text
Part 1
→ Part 2 Cue Card
→ Preparation
→ Timed Speaking
→ Part 3
```

保存：

- 音频
- 转写
- AI feedback

Voice 技术方案届时再选择：

- ChatGPT Voice 外部流程
- OpenAI Realtime
- 其他在线模型
- 本地模型

第一阶段不做网页反代，不提前绑定供应商。

---

# 36. 每日训练系统

AI 层成熟后，Workspace 可以根据真实记录决定当天练习。

可以分析：

- 哪类题弱
- 哪个 Passage 最耗时
- 最近正确率
- Writing 高频问题
- 最近训练频率
- 历史 Session

最终生成类似：

```text
今日练习
22 min

Reading Passage
+
Matching Headings Review
```

现有外部 AI 或定时任务可以成为教练层，但不能成为 Runtime 的基础依赖。

---

# 37. 开发优先级原则

采用：

```text
能真实练
→ 稳定
→ 真实内容
→ 自动化
→ AI
→ Polish
```

避免：

```text
架构设计
→ 更多架构设计
→ 通用框架
→ 通用 Parser
→ 四个月后还不能做一套题
```

每次遇到工程取舍时，优先问：

> 这个改动能否更快让 IELTS Workspace 成为真正可练习的工具？

---

# 38. 开工顺序

Coding Agent 收到本文后可以直接开工。

推荐顺序：

1. **在线调查当前 IELTS Academic 电脑机考 UI 与交互**
   - 官方 IELTS
   - British Council
   - IDP
   - 官方 familiarisation test
   - 官方视频 / screenshots
   - 必要时补充可信公开 walkthrough
   - 形成简短 UI reference 记录

2. **建立 Tauri 2 工程骨架**
   - portable release
   - `current_exe()` data root
   - dev data root
   - startup write probe
   - long path support

3. **定义 Exam / Session Schema v1**
   - discriminated Question union
   - QuestionGroup
   - scoringPolicy
   - schemaVersion
   - AI 前向字段

4. **建立 Git fixtures**
   - 每种主要 Renderer 一个小型自编题组
   - 不使用版权题目

5. **先实现 Scoring Engine**
   - acceptedAnswers
   - normalization
   - group scoring
   - 单元测试

6. **实现 Runtime 核心**
   - Session
   - Answer State
   - End Condition
   - Navigation
   - Review
   - Policy
   - Submit

7. **实现 Reading UI**
   - 参考网上查到的真实机考资料
   - 双栏
   - Navigator
   - Timer
   - Review
   - Submit

8. **实现 Highlight / Notes**
   - NFC
   - Unicode code point
   - SHA-256
   - Recovery
   - 测试

9. **实现 Session 持久化**
   - 原子安全
   - 崩溃恢复
   - runtime write warning

10. **手工转换至少一套官方 Academic Reading Sample**
    - JSON 或一次性脚本
    - 不建设通用 Importer

11. **用真实官方 Sample 跑完整 Reading Mock**
    - 修 Schema
    - 修 Renderer
    - 修判分

12. **再次联网核对当前真实 UI**
    - 对照实际行为 polish
    - 不凭印象

13. **完成 Reading Milestone 验收**

14. **进入 Listening**

15. **进入 Writing**

16. **进入 Importer**

17. **进入 AI Learning Layer**

---

# 39. Coding Agent 自主空间

本文只锁定：

- 产品目标
- 便携数据原则
- Runtime / Importer / AI 分层
- Schema 关键契约
- Scoring 基本原则
- Session 数据安全
- Highlight 高风险设计
- 真实机考资料必须在线查证
- 核心验收标准

Coding Agent 可自主决定：

- Vue / 状态管理方式
- 前端组件拆分
- CSS / UI library
- Rust module 结构
- JSON 文件拆分
- 原子写入实现
- 测试框架
- Renderer 最终数量
- Importer 算法
- 错误类型设计
- Build tooling
- 代码风格
- 内部目录细节

只要没有违反硬约束，不要为了理论上的“最优架构”推翻已经稳定可工作的实现。

---

# 40. 开工完成后的首要验收目标

Coding Agent 第一轮工作的最终目标非常明确：

> 用户双击便携版 IELTS Workspace.exe，在中文管理界面选择一套真实官方 Academic Reading Sample，进入全英文、参考当前真实 IELTS on Computer 环境实现的 Reading Mock，正常完成整套题目，使用导航、Review、Highlight、Notes，在固定时间结束后提交并得到可信 Raw Score；整个过程中 Session 可安全恢复，用户能够把它当成真正的雅思练习软件使用。

达到这一点以后，再进入 Listening。

无需继续等待下一轮架构评审。
