# IELTS 题库校对 · 执行手册

**版本** 1.0 · 2026-08-24
**执行者** 任何具备「读图 + 跑命令 + 写 JSON」能力的模型
**工作目录** `C:\Users\15pro\Desktop\MyProject\IELTS Workspace`（下称「仓库根」，所有命令都在这里跑）

---

## 0. 先读这一节：你的角色

这个仓库是一个本地雅思机考模拟器。它的题库有 **2790 道题是坏的** —— 题面是占位符、是听力原文被切碎的片段、或者答案键被 OCR 成了中文水印。

坏题分布在剑桥雅思 4–21 共 18 册、212 份试卷里。原书 PDF 就在仓库里。

**你的工作只有一件事：**

> 打开一张渲染好的原书页面图片，把上面印的题目**一字不差地抄下来**，写进指定的 JSON 文件。

**你不需要做的事**（已经有脚本做完了，不要重写）：

- 不需要决定先修哪道题 —— `50_worklist.py` 排好了
- 不需要找题在第几页 —— 工单里写着，图片已经渲染好了
- 不需要自己判断修得对不对 —— `70_write_overlay.py` 会校验
- 不需要自己写解析脚本 —— 写了也不会被采用

**你唯一的判断权是：这张图上印的字是什么。** 其余全部按本手册执行。

---

## 1. 绝对禁令

违反任何一条，本轮工作作废，整册回炉。

| # | 禁令 | 为什么 |
|---|------|--------|
| **1** | **禁止不看图就写题面。** 不许从工单里的 `currentPrompt` 猜，不许从 `acceptedAnswers` 反推，不许"根据雅思常见题型合理推测"。 | 坏题面正是要被替换掉的东西，照抄它等于没干活 |
| **2** | **禁止只交一部分。** 一个工单里的题必须一次全部提交。 | 半修的试卷比没修的更难排查 |
| **3** | **禁止为了通过校验而编造。** 校验不通过就重读图，不是改数据去迎合校验。 | |
| **4** | **禁止用 `flagged` 当逃生舱。** `flagged` 只用于「图片确实缺失或糊得读不出」。全册 `flagged` 超过 5% 直接判不合格。 | |
| **5** | **禁止修改 `scripts/` 下的任何脚本。** 脚本报错就照第 9 节处理，或停下来报告。 | |
| **6** | **禁止手改 `fixtures/cambridge/*.json`。** 只能通过 overlay 流程写入。 | 手改会被下一次 `40_apply.py` 覆盖 |
| **7** | **禁止跳过 `80_audit.py`。** 没跑通验收的册子不算做完。 | |
| **8** | **禁止跳步。** 第 5 节的 7 个步骤按顺序做完，不许合并、不许省略。 | |

---

## 2. 环境检查（每次开工跑一遍）

```powershell
cd "C:\Users\15pro\Desktop\MyProject\IELTS Workspace"

python --version                    # 期望 3.12+
python -c "import fitz; print(fitz.__doc__)"   # PyMuPDF，用于渲染 PDF
git status --short                  # 应当干净，或只有你自己的 overlay 改动
```

三条都正常才继续。`fitz` 缺失时用 `G:\python\python.exe` 跑（那个环境里有）。

---

## 3. 一次性准备（整个项目只跑一次，已经跑过就跳过）

按顺序，每步都要看到期望输出才能进下一步。

```powershell
# 3.1 建立验收基线（同时生成损坏清单）
python scripts/verify_cambridge.py --baseline --health
```
期望：末尾出现 `ALL 2810/5600 healthy (50.2%) · 2790 must be repaired`，
以及 `Damage ratchet: 2790 vs baseline 2790 (unchanged)`。
数字可能因为已有进度而不同，**只要 ratchet 那行不是 `UP`** 就正常。

```powershell
# 3.2 源码区间索引（markdown ↔ 试卷/section）
python scripts/repair/00_index_sources.py
```
期望：18 册每册都是 `4  4`（4 听力 + 4 阅读）。
唯一允许的警告是 `WARN C04: no audioscript appendix found`。

```powershell
# 3.3 题目 → PDF 页码映射
python scripts/repair/05_page_map.py
```
期望：`5600 questions mapped; 5308 (94%) land on a single page`。
**低于 90% 就是出问题了，停下来报告，不要继续。**

```powershell
# 3.4 听力原文（校对听力题时的旁证）
python scripts/repair/20_extract_transcripts.py
```
期望：`64/64 papers extracted`。

```powershell
# 3.5 音频 Part 边界
python scripts/repair/30_part_offsets.py
```
期望：`68/68 tests have usable Part boundaries`。

---

## 4. 分册顺序（不许自己改）

作者 2026 年 10 月考试，剑 4–15 是日常练习主力，剑 16–21 留作最后模考。

```
第一批（先做，按此顺序）：  8 → 6 → 4 → 5 → 7 → 9 → 10 → 11 → 12 → 13 → 14 → 15
第二批（后做）：            16 → 17 → 18 → 19 → 20 → 21
```

剑 8 和剑 6 放最前面是因为它们是损坏率的两个极端，先跑完这两册可以校准节奏。

**一册没通过 `80_audit.py` 之前，不许开下一册。**

---

## 5. 主循环：一册怎么做

以剑 8 为例。把命令里的 `8` 换成当前册号。

### 步骤 1 · 生成本册工单并渲染页面

```powershell
python scripts/repair/50_worklist.py --book 8
```

输出示例：
```
C08    25 tasks    52 pages     0/120 questions reviewed
```

产物：
- 工单：`data-dev/repair/tasks/C08/<taskId>.task.json`
- 图片：`data-dev/repair/renders/C08/pNNNN.jpg`

### 步骤 2 · 取下一个未完成工单

```powershell
python scripts/repair/50_worklist.py --book 8 --status --next 1
```

输出会给出 `NEXT <taskId>  pdf pages [...]  N questions`。

### 步骤 3 · 读工单

打开 `data-dev/repair/tasks/C08/<taskId>.task.json`。字段含义：

| 字段 | 含义 |
|---|---|
| `taskId` | 工单号，提交时要原样回填 |
| `examId` | 属于哪份试卷 |
| `pdf` | 原书 PDF 路径 |
| `pdfPagesZeroBased` / `pdfPageNumbers` | PDF 里的第几页（**不是**书上印的页码） |
| `images` | 已渲染好的图片路径，**你要读的就是这些** |
| `questions[]` | 本单要修的题 |
| `questions[].number` | 题号（1–40） |
| `questions[].currentPrompt` | **当前的坏题面。只用来对照，绝不许照抄** |
| `questions[].currentType` | 当前题型（可能是错的） |
| `questions[].acceptedAnswers` | 当前答案键（**可能也是坏的**，见第 8 节） |
| `questions[].damageReasons` | 验收门判定它坏的原因 |
| `questions[].groupInstruction` | 当前的题组说明（可能是坏的） |

### 步骤 4 · 逐张读图

按 `images` 顺序把每张图都看一遍。你要从图上找到：

1. **页脚印的页码**（通常在页面左下或右下角，是个 2–3 位数字）→ 提交时填 `printedPageNumber`
2. **所有 `Questions a–b` 标题**（例如 `Questions 8–13`）→ 提交时填 `questionsHeadingSeen`
3. **本单每道题的完整题面**
4. 如果是选择题 / 配对题 / 标题配对题：**完整的选项列表**

**找不到本单题号对应的标题怎么办** → 见第 9.1 节，用 `--expand`，**不许猜**。

### 步骤 5 · 写提交文件

在工单**同目录**下建 `<taskId>.answer.json`。格式见第 6 节。

### 步骤 6 · 先自检，再写入

```powershell
# 先 dry-run，不写任何东西
python scripts/repair/70_write_overlay.py --task <taskId> --check-only
```

- 输出 `{"ok": true, ...}` → 进入正式写入
- 输出 `REJECTED: ...` → **回到步骤 4 重读图**，按报错逐条修正，再自检。
  **不允许**通过删题、改成 `flagged`、或凑字数来绕过。

```powershell
# 自检通过后正式写入 overlay
python scripts/repair/70_write_overlay.py --task <taskId>
```

期望输出：`{"ok": true, "taskId": "...", "questions": N, "overlay": "fixtures/overlays/....json"}`

### 步骤 7 · 回到步骤 2，直到本册 `remaining` 为 0

```powershell
python scripts/repair/50_worklist.py --book 8 --status
```
看到 `120/120 questions reviewed` 才算读完。

---

## 6. 提交文件格式规范（`<taskId>.answer.json`）

### 6.1 整体结构

```json
{
  "taskId": "cambridge-8-test-1-reading-p0012",
  "printedPageNumber": 20,
  "questionsHeadingSeen": ["Questions 9-13", "Questions 14-19"],
  "questions": [
    { "number": 9,  "status": "corrected", "type": "completion",
      "prompt": "Excellent condition, despite the ___ of 2001",
      "acceptedAnswers": ["earthquake"] },

    { "number": 14, "status": "corrected", "type": "matching",
      "prompt": "Paragraph A",
      "acceptedAnswers": ["ii"],
      "options": [
        {"label": "i",    "text": "Disobeying FAA regulations"},
        {"label": "ii",   "text": "Aviation disaster prompts action"},
        {"label": "iii",  "text": "Two coincidental developments"},
        {"label": "iv",   "text": "Setting altitude zones"},
        {"label": "v",    "text": "An oversimplified view"},
        {"label": "vi",   "text": "Controlling pilots' licences"},
        {"label": "vii",  "text": "Defining airspace categories"},
        {"label": "viii", "text": "Setting rules to weather conditions"},
        {"label": "ix",   "text": "Taking off safely"},
        {"label": "x",    "text": "First steps towards ATC"}
      ] }
  ]
}
```

### 6.2 顶层字段

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `taskId` | string | ✅ | 必须与工单完全一致 |
| `printedPageNumber` | int | ✅ | **书页脚印的那个数字**，不是 PDF 页序号。第一单会自动学习本册偏移量，之后必须对得上 |
| `questionsHeadingSeen` | string[] | ✅ | 图上看到的每一条 `Questions a–b` 标题，原样抄。**必须覆盖本单全部题号**，否则整单拒收 |
| `questions` | array | ✅ | 本单**每一道**未审题目，一道不能少、不能多 |

### 6.3 每道题的字段

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `number` | int | ✅ | 题号，与工单一致 |
| `status` | string | ✅ | 见 6.3.1 |
| `type` | string | ✅ | 见 6.4 |
| `prompt` | string | ✅（flagged 除外） | 题面原文，见 6.5 |
| `acceptedAnswers` | string[] | 见 6.6 | 省略则沿用工单里的旧答案 |
| `options` | array | 选项类题型必填 | 见 6.7 |
| `gapText` | string | 可选 | 填空题的带空格全文，如 `Has two ____ levels` |
| `note` | string | flagged 必填 | ≥10 字，说明读不出什么 |

#### 6.3.1 `status` 怎么选（容易踩坑）

| 值 | 什么时候用 |
|---|---|
| `corrected` | 图上的题面/选项/答案与工单里的**不一样**，你把它改对了 |
| `approved` | 图上的题面与工单里的 `currentPrompt` **完全一致**，这道题被判损坏是因为**答案键坏了**（`damageReasons` 里是 `has OCR junk in acceptedAnswers`）。题面照抄，答案填新的 |
| `flagged` | 图确实读不出。**只有这一种情况**能用 |

**踩坑点**：题面没变却填 `corrected` 会被拒收，报错
`prompt is unchanged from the broken original`。这时改成 `approved` 即可 ——
`approved` 是唯一允许题面与原值相同的状态，但它仍要通过其余全部规则。

### 6.4 `type` 取值

| 值 | 用于 |
|---|---|
| `completion` | 填空（笔记/表格/摘要/流程图/句子补全） |
| `short_answer` | 简答（Answer the questions below） |
| `single_choice` | 单选 A/B/C/D |
| `multi_choice` | 多选（Choose TWO letters） |
| `matching` | 配对，含 List of Headings（答案是 i/ii/iii 或 A/B/C） |
| `labelling` | 地图/图表标注 |
| `true_false_ng` | TRUE / FALSE / NOT GIVEN |
| `yes_no_ng` | YES / NO / NOT GIVEN |

**判定口诀**：答案是罗马数字 → `matching`；答案是单个大写字母且题干在问「选哪个」→ `single_choice`；答案是 TRUE/FALSE/NOT GIVEN → `true_false_ng`；答案是从原文抄的单词 → `completion`。

### 6.5 `prompt` 规则（校验会逐条检查）

- 长度 ≥ 12 字符（`matching` / `labelling` ≥ 5，因为「Paragraph A」是合法题面）
- **不许**等于 `currentPrompt`
- **不许**含中日韩字符、`✓`、`✗`、`√`、`×`、`□`
- **不许**含 `Q1`–`Q40` 这类听力原文的答案位置标记
- **不许**是题组说明本身（`Complete the notes below.` 这种整句以句号结尾的祈使句）
- **不许**以标点开头（`, . ; : ! ? ) ] }`）
- **不许**以半个单词开头（`ou should spend`、`n order to`）
- **不许**含 `\_` `\*` 这类 markdown 转义残留
- 同一份试卷内**不许重复**
- 空格用 `___`（三个下划线）表示，不要用点线

### 6.6 `acceptedAnswers` 规则

- 非空数组，每项非空
- 不含中日韩字符与勾叉符号
- `true_false_ng` 只能是 `TRUE` / `FALSE` / `NOT GIVEN`
- `yes_no_ng` 只能是 `YES` / `NO` / `NOT GIVEN`
- 选项类题型：每个答案必须在 `options` 的 label 集合里
- 一题多种可接受写法就都列出来，例如 `["big", "large enough"]`

### 6.7 `options` 规则

- `single_choice` / `multi_choice` / `matching` / `labelling` 必填，且 ≥ 2 项
- 每项 `{"label": "...", "text": "..."}`，label 原样（`A`、`i`、`vii`）
- label 不许重复，text 不许为空
- **选项列表要从图上抄全**，缺一项会导致答案对不上而被拒

---

## 6.8 完整范例（已实测跑通，可直接照抄结构）

工单 `cambridge-8-test-1-listening-p0008`，两张图 `p0008.jpg`（书页 10）、
`p0009.jpg`（书页 11），三道题：

| 题号 | 工单里的现状 | 损坏原因 |
|---|---|---|
| 2 | prompt `George wants to sit at the back so they can`，答案 `["张听力录音光盘"]` | 答案键是水印 |
| 3 | prompt `Write the answer from the source question.`，type `true_false_ng` | 占位符题面 + 题型也错了 |
| 4 | prompt `TELEPHONE:`，答案 `["套完整的学术类雅思全真试题"]` | 答案键是水印 |

读图看到：

- p0008（书页 10）：`SECTION 1 Questions 1-10` / `Questions 1 and 2` /
  第 2 题 `George wants to sit at the back so they can`，选项 A see well. /
  B hear clearly. / C pay less.
- p0009（书页 11）：`Questions 3-10` / `Complete the form below.` /
  一张 SUMMER MUSIC FESTIVAL BOOKING FORM 表格，
  `ADDRESS: 3 .........., Westsea`、`POSTCODE: 4 ..........`
- 答案键（书页 152，PDF 第 151 页）：`2 B` / `3 48 North Avenue` / `4 WS6 2YH`

提交文件：

```json
{
  "taskId": "cambridge-8-test-1-listening-p0008",
  "printedPageNumber": 11,
  "questionsHeadingSeen": ["SECTION 1 Questions 1-10", "Questions 1 and 2", "Questions 3-10"],
  "questions": [
    { "number": 2, "status": "approved", "type": "single_choice",
      "prompt": "George wants to sit at the back so they can",
      "acceptedAnswers": ["B"],
      "options": [
        {"label": "A", "text": "see well."},
        {"label": "B", "text": "hear clearly."},
        {"label": "C", "text": "pay less."}
      ],
      "note": "answer key read from the Answer Keys page (printed 152)" },

    { "number": 3, "status": "corrected", "type": "completion",
      "prompt": "ADDRESS: ___, Westsea",
      "gapText": "ADDRESS: ___, Westsea",
      "acceptedAnswers": ["48 North Avenue"] },

    { "number": 4, "status": "corrected", "type": "completion",
      "prompt": "POSTCODE: ___",
      "gapText": "POSTCODE: ___",
      "acceptedAnswers": ["WS6 2YH"] }
  ]
}
```

注意三个细节：

1. 第 2 题题面**没变**，所以是 `approved` 不是 `corrected`（见 6.3.1）。
2. 第 3 题原本被标成 `true_false_ng`，实际是表格填空 → 改成 `completion`。
   **题型错了就要改**，不要沿用 `currentType`。
3. `printedPageNumber` 填 `11`（书页脚印的数字），不是 `10`（PDF 序号）。

跑完的实际结果：

```
$ python scripts/repair/70_write_overlay.py --task cambridge-8-test-1-listening-p0008
{"ok": true, "taskId": "...", "questions": 3, "overlay": "fixtures/overlays/cambridge-8-test-1-listening.json"}

$ python scripts/repair/40_apply.py --books 8
1 exam files changed

$ python scripts/verify_cambridge.py --baseline
{"ok": true, "damagedQuestions": 2787, ...}      # 2790 → 2787

$ python scripts/repair/50_worklist.py --book 8 --status
C08    27 tasks    52 pages     3/120 questions reviewed
```

---

## 7. 验收标准

### 7.1 单个工单（`70_write_overlay.py`）

| 结果 | 含义 | 下一步 |
|---|---|---|
| `{"ok": true}` | 合格，已写入 overlay | 下一单 |
| `REJECTED: N problem(s)` | **整单不合格，一个字都没写入** | 按报错回步骤 4 重读图，改正后重新自检 |

**重要**：拒收是整单拒收。不存在「7 道过了 5 道」。

### 7.2 单册（`80_audit.py`）

```powershell
python scripts/repair/40_apply.py --books 8        # 先把 overlay 合并进题库
python scripts/repair/80_audit.py --book 8
```

五项全 `ok` 才算过册：

| 检查 | 合格标准 | 不合格怎么办 |
|---|---|---|
| **COVERAGE** | 本册每一道损坏题都有 overlay 条目 | 回步骤 2 补做剩余工单 |
| **VALIDITY** | 每条 overlay 仍满足第 6 节全部规则 | 找到报错的题号，重读图重写 |
| **APPLIED** | fixtures 不比 overlay 旧 | 跑 `40_apply.py --books 8` |
| **GATE** | 无结构性错误，且本册损坏数没有上升 | 看报错，通常是某题写坏了 |
| **FLAGGED** | `flagged` 占比 ≤ 5% | **回炉**：把 flagged 的题重读一遍，能读出来的必须读出来 |

### 7.3 全库（全部 18 册做完后）

```powershell
python scripts/verify_cambridge.py --baseline --update-baseline --health
python scripts/repair/80_audit.py --all
.\verify.ps1
```

三条都要过。`.\verify.ps1` 是完整门（题库 + 单测 + Rust 测试 + 类型检查 + 生产构建）。

---

## 8. 答案键也可能是坏的

**这是最容易被忽略的一点。**

工单里的 `acceptedAnswers` 不一定可信。全库有 **540 处**答案是 OCR 垃圾：

```
"张听力录音光盘"   "口 2 ×"   "二 3 ×"   "一"   "品 34"   "✓ ✗"   "学术类"
```

这些是扫描版答案页的水印、表格线和勾叉被 OCR 成了答案。

**处理规则：**

1. 如果 `damageReasons` 里出现 `has OCR junk in acceptedAnswers`，**这道题的答案必须重新核对**，不能沿用。
2. 答案印在原书的 **Answer Key** 章节（通常在书的最后几十页，`Answers` / `Answer key` 标题）。
3. 用同样的方法定位并渲染答案页：

```powershell
# 找到答案页（在 PDF 后 1/4，标题是 Answer key / Answers）
python -c "import fitz; d=fitz.open(r'教材\剑桥雅思真题8.pdf'); print(d.page_count)"

# 渲染一段范围看看（把 A、B 换成实际页码区间）
python -c "import fitz; d=fitz.open(r'教材\剑桥雅思真题8.pdf'); [d[i].get_pixmap(dpi=120, colorspace=fitz.csGRAY).pil_save(rf'data-dev\repair\renders\C08\answers-{i:04d}.jpg', format='JPEG', quality=72) for i in range(A, B)]"
```

4. 答案页很密：**一页就是一整套 40 个答案**，所以这部分成本很低（全库约 36–72 页）。
5. 读出正确答案后，在对应题目的 `acceptedAnswers` 里填写。

---

## 9. 特殊情况处理

### 9.1 图上找不到本单题号的 `Questions a–b` 标题

约 5% 的工单会遇到。

（实测：拿独立的第二套 OCR 结果在剑 4/9/10/14 上核对了 220 个题组，
预测窗口本身命中 84%，向后补一页后到 95%。工单默认已经向后补了一页，
所以剩下要靠 `--expand` 的约 5%。）

```powershell
python scripts/repair/50_worklist.py --expand <taskId> --by 2
```

会把窗口左右各加宽 2 页并重新渲染。重读新图。

- 还找不到 → 再 `--by 4`，最多 `--by 6`
- `--by 6` 仍找不到 → 才允许把这些题标 `flagged`，`note` 写明「已扩展至 ±6 页仍未找到 Questions X–Y 标题」

**绝不允许**：找不到就照抄 `currentPrompt`、或按答案反推一个题面。

### 9.2 图片糊、字看不清

- 先提高分辨率重渲染那一页：

```powershell
python -c "import fitz; d=fitz.open(r'教材\剑桥雅思真题8.pdf'); d[PAGE].get_pixmap(dpi=200, colorspace=fitz.csGRAY).pil_save(r'data-dev\repair\renders\C08\hi-PAGE.jpg', format='JPEG', quality=85)"
```
（把 `PAGE` 换成 `pdfPagesZeroBased` 里的页序号）

- 200 DPI 仍读不出 → 标 `flagged`，note 写明是哪几个词读不出

### 9.3 地图题 / 图表标注题（`labelling`）

题面通常是图上的一个标号位置，没有文字题干。写法：

```json
{ "number": 15, "status": "corrected", "type": "labelling",
  "prompt": "Label 15 on the map",
  "acceptedAnswers": ["C"],
  "options": [{"label":"A","text":"car park"}, {"label":"B","text":"cafe"}, ...] }
```

图本身无法录入的，标 `flagged` 并在 note 里写「地图题，需要保留原图」。

### 9.4 剑 4 缺听力原文

剑 4 的 MinerU 输出被截断（128K，其余册 240–320K），书后听力原文附录整个丢了。

这**不影响**题面校对（题面在正文，不在附录）。若要补原文，需要重跑 MinerU：

```powershell
# 参考 scripts/mineru_cambridge.py，输出目录 data-dev/mineru/C04/
# 跑完后重新执行第 3 节的 3.2 / 3.3 / 3.4
```

**不是本轮工作的必做项**，除非明确要求。

### 9.5 脚本报错

1. 把完整报错贴出来
2. 检查是不是漏跑了第 3 节的某一步
3. **不要**改脚本、**不要**自己写替代脚本
4. 解决不了就停下来报告，说明卡在哪个 taskId 的哪一步

---

## 10. 中断与续跑

整条流水线是幂等的，随时可以停。

- 已写入 overlay 的题不会被重新排入工单（`50_worklist.py` 会跳过）
- 重跑 `50_worklist.py --book N` 不会丢失任何已完成的工作
- overlay 文件（`fixtures/overlays/*.json`）是唯一的成果载体，**任何脚本都不会覆盖它**

查看任意时刻的进度：

```powershell
python scripts/repair/50_worklist.py --status          # 全库
python scripts/repair/50_worklist.py --book 8 --status # 单册
```

**每完成一册就提交一次 git**（overlay 本身在 .gitignore 里，提交的是 fixtures 变化和基线）：

```powershell
python scripts/repair/40_apply.py --books 8
python scripts/repair/80_audit.py --book 8
python scripts/verify_cambridge.py --baseline --update-baseline
git add -A
git commit -m "fix(题库): 剑8 人工校对完成，损坏 N → M"
```

---

## 11. 来源标注

每条写入 overlay 的记录都自动带上：

| 字段 | 含义 |
|---|---|
| `status` | `corrected` / `approved` / `flagged` |
| `printedPageNumber` | 你读的那一页书页码 |
| `reviewedAt` | UTC 时间戳 |
| `note` | 你写的备注（若有） |

合并进题库后，每道题还会带 `repairSource`，标明这道题是人工改的还是自动解析的。抽查时可以直接翻回原页对照。

---

## 12. 常见拒收原因速查

| 报错 | 原因 | 怎么修 |
|---|---|---|
| `question(s) [..] not submitted` | 少交了题 | 补齐，整单重交 |
| `prompt is unchanged from the broken original` | 照抄了 `currentPrompt` | 回去读图 |
| `prompt is still placeholder text` | 抄了「Write the answer from the source question.」 | 回去读图 |
| `prompt is the group instruction, not a question` | 把「Complete the notes below.」当成了题面 | 题面是题号后面那句，不是说明 |
| `prompt starts mid-word` | 抄到了 OCR 残字 | 从图上重抄完整单词 |
| `prompt duplicates question X` | 两道题写成了一样 | 至少有一道抄错了 |
| `answers [..] are not among the option labels` | 选项没抄全，或题型判错 | 补全选项 / 改 type |
| `questionsHeadingSeen ... does not cover question(s) [..]` | 看错页了 | 见 9.1，用 `--expand` |
| `printedPageNumber ... is inconsistent with book N` | 页码填成了 PDF 序号 | 填**书页脚印的**数字 |
| `flagged questions need a 'note'` | flagged 没写理由 | 写清楚读不出什么 |
| `type X needs at least two options` | 选项类题型没给 options | 从图上抄选项列表 |

---

## 13. 命令速查

```powershell
cd "C:\Users\15pro\Desktop\MyProject\IELTS Workspace"

# —— 一次性准备 ——
python scripts/verify_cambridge.py --baseline --health
python scripts/repair/00_index_sources.py
python scripts/repair/05_page_map.py
python scripts/repair/20_extract_transcripts.py
python scripts/repair/30_part_offsets.py

# —— 每册循环 ——
python scripts/repair/50_worklist.py --book 8                    # 建工单 + 渲染
python scripts/repair/50_worklist.py --book 8 --status --next 1  # 取下一单
#   → 读图 → 写 <taskId>.answer.json
python scripts/repair/70_write_overlay.py --task <taskId> --check-only   # 自检
python scripts/repair/70_write_overlay.py --task <taskId>                # 写入
python scripts/repair/50_worklist.py --expand <taskId> --by 2    # 找不到标题时

# —— 每册收尾 ——
python scripts/repair/40_apply.py --books 8
python scripts/repair/80_audit.py --book 8
python scripts/verify_cambridge.py --baseline --update-baseline --health

# —— 全库收尾 ——
python scripts/repair/80_audit.py --all
.\verify.ps1
```

---

## 14. 工作量参考

| 项 | 数量 |
|---|---|
| 待修题目 | 2790 |
| 工单数 | 545 |
| 需要读的页面 | 982（去重后） |
| 平均每单题数 | 5.1 |
| 平均每单页数 | 1.8 |
| 图片总体积 | 约 600 MB（灰度 JPEG 120 DPI） |
| 另需读的答案页 | 约 36–72 页（一页 = 一整套 40 个答案） |

大多数工单看 2 张图即可（预测页 + 向后补的一页）。

---

## 14A. 第二轮：组级校对（题目说明 + 选项文字）

第一轮修的是**题干和答案**。第二轮修的是学生在屏幕上同样会看到、
但第一轮完全没碰的两样东西：

| 缺什么 | 后果 | 数量 |
|---|---|---|
| 组说明（rubric） | 学生不知道字数上限、不知道要选几个 | 477 组 |
| 选项/词库文字 | 屏幕上只有一排空按钮 A/B/C，没法作答 | 830 组 + 324 题 |

其中 2653 条说明已经由 `60_recover_rubrics.py` **自动补好了**，不需要你做。
它把 OCR 行匹配到脚本里的规范模板再输出规范文本，所以
`anSwer` / `woRD` / `lertter` / `ChooseTWO` 这类 OCR 噪声是被修好，不是被沿用。
匹配不上的一律不猜，才落到你手上。

### 14A.1 命令

```bash
# 自动那一半（整个项目只跑一次，已经跑过就跳过）
python scripts/repair/60_recover_rubrics.py --clean-existing --apply

# 排组级工单（和第一轮一样支持 --status / --next / 断点续跑）
python scripts/repair/62_group_worklist.py --book 8
python scripts/repair/62_group_worklist.py --book 8 --next 1

# 读图 → 写 <taskId>.answer.json → 自检 → 写入
python scripts/repair/72_write_group_overlay.py --task <taskId> --check-only
python scripts/repair/72_write_group_overlay.py --task <taskId>

# 收尾同第一轮
python scripts/repair/40_apply.py --books 8
python scripts/verify_cambridge.py --baseline --health
```

工单文件在 `data-dev/repair/group-tasks/C08/`，任务 id 形如
`cambridge-8-test-1-listening-g0008`（第一轮是 `-p0008`，注意区别）。

### 14A.2 提交格式

```json
{
  "taskId": "cambridge-8-test-1-listening-g0008",
  "printedPageNumber": 11,
  "questionsHeadingSeen": ["SECTION 1 Questions 1-10", "Questions 3-10"],
  "groups": [
    {
      "groupId": "c8t1l-g3",
      "status": "corrected",
      "instruction": "Complete the form below. Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer."
    },
    {
      "groupId": "c8t1l-g11",
      "status": "corrected",
      "options": [
        { "label": "A", "text": "the gym" },
        { "label": "B", "text": "the tracks" },
        { "label": "C", "text": "the indoor pool" },
        { "label": "D", "text": "the outdoor pool" },
        { "label": "E", "text": "the sports training for children" }
      ]
    }
  ]
}
```

`printedPageNumber` 与 `questionsHeadingSeen` 的规则和第一轮完全一样，
校验也一样严：整单接受或整单拒绝，页码要对得上本册已标定的偏移，
标题必须覆盖本单全部题号。

### 14A.3 三条组级专属规则

1. **`instruction` 只写印在页面上的那一两句说明。**
   超过 220 字符会被拒——那说明你把题目正文一起抄进来了。
   听力卷的说明里出现 `Reading Passage` / `on your answer sheet` 一律拒收：
   那是导入器从隔壁抄错的，不是页面上印的。

2. **`options` 必须覆盖答案键用到的每一个字母。**
   脚本知道这一组的答案是 `['D']` 还是 `['A','E']`，
   你交的选项列表里没有那个字母就会被拒——说明你读错了框。
   每个选项都必须有文字，空文字正是要修的毛病。

3. **页面上根本没有选项框时，用 `flagged` 并写清楚。**
   这不是偷懒，是正确答案。真实例子（剑8 Test1 听力 q9）：

   > 页面上没有选项列表。Questions 3-10 全是表格填空，第 9 题是
   > 23 June 那一行的 "No. of tickets" 格。fixture 里的 single_choice、
   > 8 个空选项、答案键 'D' 三者都是错的，需要的是题干级修复而不是选项转写。

   这类会转回第一轮的题干工单处理。

### 14A.4 工作量

| 项 | 数量 |
|---|---|
| 待修组 | 1210 |
| 工单数 | 298 |
| 需要读的页面 | 573（大部分第一轮已经渲染过） |

---

## 14B. 已知不在这两轮范围内的问题

下面这些**不要动**，它们需要的是重新切分而不是读页面转写，
由主会话另行处理。看到了就跳过：

- 6 份阅读卷文章区完全空白（剑6 T1/T2/T3、剑7 T2/T3、剑20 T1）
- 6 份阅读卷三篇文章是同一坨未切分文本（剑5 T3/T4、剑6 T4、剑9 T4、剑17 T2、剑20 T2）
- 6 份写作卷题干只有占位符（剑5 T4、剑6 T1–T4、剑9 T1）
- 剑21 没有听力（`听力/` 只到剑20，缺音频源）
- 剑4 缺 4 份听力原文（markdown 被截断）

---

## 14C. 一个必须知道的事实：门禁会漏

随机抽 4 道门禁判定为"健康"的题去比对原书，2 道题面完全取错了行
（剑6 T1 听力 35 的题面是别处的句子；剑12 T3 听力 4 的题面抄成了第 5 题那一行），
另外 2 道有 OCR 错字。**答案是对的，题面是错的**，而且读起来像正常英文，
所以任何自动规则都抓不到。

这意味着：

- `verify_cambridge.py` 报的健康度是**上限，不是真相**。
- 只要你手上这一页恰好印着别的题，**顺手核对同页其它题**，
  发现题面对不上就照第一轮流程提交修正——哪怕门禁没把它列为损坏。
- 不要因为"门禁说它是好的"就跳过明显不对的题。

---

## 15. 完成的定义

全部满足才算这件事做完：

**第一轮（题干 + 答案）**

- [ ] 18 册 `80_audit.py --all` 全部 PASS
- [ ] `verify_cambridge.py --health` 显示健康度 ≥ 95%
- [ ] 全库 `flagged` 题数 ≤ 140（5%）
- [ ] `.\verify.ps1` 全绿
- [ ] `fixtures/cambridge-health-baseline.json` 已更新并提交
- [ ] 抽查任意 20 道修过的题，题面与原书一致

**第二轮（组说明 + 选项文字）**

- [ ] `62_group_worklist.py --status` 显示 1210/1210 组已处理
- [ ] `verify_cambridge.py` 的 `contentGaps` 从 1673 降到 ≤ 60
      （余下的是 14B 那批不在本轮范围内的）
- [ ] 抽查任意 10 组，说明与选项文字与原书一致
- [ ] 抽查任意 5 道带字母答案的题，在应用里能真正选得动
