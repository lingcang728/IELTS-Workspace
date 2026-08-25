# IELTS 题库校对 · 第四轮执行手册（组级：题目说明 + 选项文字）

> 本手册**只讲第四轮**。前三轮已做完：第一轮题干+答案键 2790 处；第二、三轮
> 组级校对把内容缺口从 1638 压到 1005。本轮是**重开第三轮被 flagged 的组**。
>
> ## 为什么要重开：上一轮的 flag 大多不是你的错，是题库的错
>
> 第三轮有 747 个组被标成 flagged，理由高度集中在同一句话：
> **「工单声明 A–H，页面上只有 A–C」**。那些 flag 判断是对的——页面没错，
> 题库错了。导入器给几乎所有选择题盖了统一的 A–H 选项集，而剑桥根本不这么印：
> 听力三选一印 A–C，List of Headings 印 i–viii，段落定位题用文章自己的 A–F，
> 词库题用 A–J。
>
> **这个结构缺陷现在已经修好了**（`64_fix_option_structure.py`，374 处选项集
> 按印刷说明裁正）。所以工单现在声明的标签就是页面上真实印着的标签，
> 之前那个堵点没有了，这些组现在**抄得动了**。
>
> 也就是说：如果你想写「工单声明 A–H 但页面只有 A–C」这种 flag，**先停下来
> 再看一眼工单**——它多半已经只声明 A–C 了。真遇到仍然对不上的，照常 flag，
> 但请写清页面上实际印的是什么。


## 0. 你的角色

你要做的只有一件事：**看一张页面图片，把上面印的字抄下来**。

具体是两样东西：

| 缺什么 | 学生看到的后果 | 数量 |
|---|---|---|
| **题目说明**（rubric） | 不知道字数上限，不知道要选几个 | 472 组 |
| **选项/词库文字** | 屏幕上一排空按钮 A / B / C，根本没法作答 | 830 组 + 324 题 |

判断什么该做、做哪一页、做完算不算数——**全部由脚本决定**，不是你决定。

已经有 2653 条说明被 `60_recover_rubrics.py` 自动补好了，不需要你碰。
它把 OCR 行匹配到规范模板再输出规范文本，所以 `anSwer` / `woRD` /
`lertter` / `ChooseTWO` 这类噪声是**被修好**而不是被沿用。匹配不上的
才落到你手上——正因为如此，**落到你手上的都是脚本认不出来的硬骨头**。

---

## 1. 绝对禁令

违反任何一条，这一册作废重做。

1. **不许跳步。** 每一单都必须：读图 → 写提交文件 → `--check-only` 自检 →
   正式写入。不许跳过自检，不许"看起来差不多"就写入。
2. **不许猜。** 页面上没印的字，一个都不许写。看不清就 `--expand` 再看，
   还看不清就 `flagged` 并写清楚原因。
3. **不许手改题库。** `fixtures/cambridge/*.json` 只能由 `40_apply.py` 写。
   你只写 `<taskId>.answer.json`。
4. **不许手改 overlay。** `fixtures/overlays/*.json` 只能由
   `72_write_group_overlay.py` 写。
5. **不许改脚本**，包括阈值、校验规则、页码常量。被拒了就按提示改提交内容，
   不是改脚本。
6. **不许挑简单的做。** 工单按册按顺序走，一单里的所有组要么全交要么不交。
7. **不许改基线。** `fixtures/cambridge-health-baseline.json` 只准降不准升，
   而且只在整册收尾时由 `--update-baseline` 写。
8. **不许伪造页码。** `printedPageNumber` 写页脚真实印的数字。每册的偏移量
   脚本第一次就标定好了，编造的立刻会被抓。

---

## 2. 环境检查（每次开工跑一遍）

```bash
cd "C:\Users\15pro\Desktop\MyProject\IELTS Workspace"
python --version                 # 3.11+
python -c "import fitz; print(fitz.__doc__)"   # PyMuPDF，用来渲染 PDF
git status --short               # 应该是干净的
```

工作树不干净就先停下来问，不要在别人没提交的改动上面盖。

---

## 3. 一次性准备（整个项目跑一次，已经跑过就跳过）

第一轮已经全部跑过，正常情况下这一节你什么都不用做。
只有在 `data-dev/repair/` 被清空时才需要重跑：

```bash
python scripts/verify_cambridge.py --baseline --health   # 生成损坏/缺口清单
python scripts/repair/00_index_sources.py                # 源码区间索引
python scripts/repair/05_page_map.py                     # 题 → PDF 页码
python scripts/repair/60_recover_rubrics.py --clean-existing --apply   # 自动补说明
```

跑完确认：

```bash
python scripts/verify_cambridge.py --skip-audio --baseline
# 期望 contentGaps 约 1673，errors 0
```

---

## 4. 分册顺序（不许自己改）

由易到难，先把手感练出来再碰难的：

```
8 → 6 → 4 → 5 → 7 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20 → 21
```

**一册没通过第 7 节的验收，不许开下一册。**

| 册 | 工单 | 页 | 组 |     | 册 | 工单 | 页 | 组 |
|---|---:|---:|---:|---|---|---:|---:|---:|
| C08 | 17 | 32 | 65 |  | C13 | 16 | 32 | 63 |
| C06 | 25 | 53 | 201 |  | C14 | 7 | 15 | 29 |
| C04 | 24 | 48 | 68 |  | C15 | 11 | 17 | 25 |
| C05 | 22 | 40 | 103 |  | C16 | 7 | 15 | 18 |
| C07 | 21 | 39 | 66 |  | C17 | 18 | 38 | 74 |
| C09 | 18 | 35 | 49 |  | C18 | 24 | 37 | 76 |
| C10 | 15 | 32 | 78 |  | C19 | 14 | 26 | 51 |
| C11 | 17 | 33 | 62 |  | C20 | 22 | 44 | 96 |
| C12 | 17 | 31 | 72 |  | C21 | 3 | 6 | 9 |

合计 **214 工单 / 411 页 / 670 组**。

---

## 5. 主循环：一册怎么做

以剑 8 为例。

### 5.1 排工单并渲染页面

```bash
python scripts/repair/62_group_worklist.py --book 8
```

工单写到 `data-dev/repair/group-tasks/C08/`，页面图写到
`data-dev/repair/renders/C08/`（120 DPI 灰度 JPEG，第一轮大多已经渲染过）。

### 5.2 取下一单

```bash
python scripts/repair/62_group_worklist.py --book 8 --next 1
```

输出形如：

```
NEXT cambridge-8-test-1-listening-g0008  pdf pages [9, 10]  6 groups
```

**注意任务 id 结尾是 `-g0008`**（第一轮是 `-p0008`），两者是不同的工单，不要弄混。

### 5.3 读工单

打开 `data-dev/repair/group-tasks/C08/cambridge-8-test-1-listening-g0008.task.json`：

```json
{
  "taskId": "cambridge-8-test-1-listening-g0008",
  "examId": "cambridge-8-test-1-listening",
  "module": "listening",
  "pdfPageNumbers": [9, 10],
  "images": ["data-dev/repair/renders/C08/p0008.jpg",
             "data-dev/repair/renders/C08/p0009.jpg"],
  "groups": [
    {
      "groupId": "c8t1l-g3",
      "numbers": [3],
      "currentInstruction": "Write the answer from the source question.",
      "questionType": "true_false_ng",
      "optionLabels": [],
      "optionTextPresent": 0,
      "stems": [{"number": 3, "prompt": "ADDRESS: ___, Westsea",
                 "acceptedAnswers": ["48 North Avenue"]}],
      "gapReasons": ["has a placeholder instruction ... "],
      "alreadyReviewed": false
    }
  ]
}
```

关键字段：

- `gapReasons` —— 告诉你这一组缺的是**说明**还是**选项文字**，照它做。
- `stems` —— 该组各题的题面和答案键。**用它来确认你在页面上找对了位置**：
  页面上的题号和题面要和这里对得上。
- `optionLabels` —— 题库里已有的选项字母。你交的选项必须至少覆盖这些字母。
- `alreadyReviewed: true` —— 已经做过，不用再交。

### 5.4 看图

把 `images` 列出的图片逐张看完。你要在图上找到：

1. **本单题号所在的 `Questions a-b` 标题**，以及标题下面那一两句斜体说明。
2. 如果 `gapReasons` 提到选项，还要找到**那个选项框**（MCQ 的 A/B/C 列表，
   或者 matching / 选词填空的方框）。
3. **页脚印的页码**（不是 PDF 第几页，是书上印的数字）。

### 5.5 写提交文件

写到 `data-dev/repair/group-tasks/C08/<taskId>.answer.json`。
格式规范见第 6 节。

### 5.6 自检

```bash
python scripts/repair/72_write_group_overlay.py --task cambridge-8-test-1-listening-g0008 --check-only
```

**`ok: false` 就回到 5.4 重看图重写，不许改脚本。** 常见拒收原因见第 9 节。

### 5.7 正式写入

```bash
python scripts/repair/72_write_group_overlay.py --task cambridge-8-test-1-listening-g0008
```

### 5.8 重复直到本册工单清零

```bash
python scripts/repair/62_group_worklist.py --book 8 --status
# 直到显示 65/65 groups reviewed
```

### 5.9 本册收尾

```bash
python scripts/repair/40_apply.py --books 8
python scripts/verify_cambridge.py --baseline --health
```

确认 `contentGaps` 比开工前**下降**了。没下降就是没生效，回头查。

---

## 6. 提交文件格式规范

### 6.1 整体结构

```json
{
  "taskId": "cambridge-8-test-1-listening-g0008",
  "printedPageNumber": 11,
  "questionsHeadingSeen": ["SECTION 1 Questions 1-10", "Questions 3-10"],
  "groups": [ /* 见 6.4 */ ]
}
```

### 6.2 `taskId`

必须和工单文件里的 `taskId` **一字不差**。

### 6.3 `printedPageNumber`

**书页脚印的那个数字**，不是 PDF 的第几页。剑桥的前置页会让两者差 -3 到 +9 不等。

脚本第一次遇到某册时会用你交的数字标定这一册的偏移量，之后凡是偏离
超过 ±2 的都会被拒。所以：**第一单一定要看准页脚**，标错了整册都会连坐。

如果一单跨两页，写你**主要读的那一页**的页码。

### 6.4 `questionsHeadingSeen`

把页面上印的 `Questions a-b` 标题**原样抄下来**，一行一条。

脚本会从里面解析出题号区间，并要求它**覆盖本单所有组的所有题号**。
覆盖不了就会被拒——这是"你确实看了这一页"的证据，编不出来。

例：页面上印着 `SECTION 1  Questions 1–10` 和 `Questions 3–10`，
本单的组覆盖题 3/4/6/7/9/10，那么两条都抄上，解析出 1..10 ⊇ {3,4,6,7,9,10}，通过。

### 6.5 `groups[]` —— 每组一个对象

工单里 `alreadyReviewed: false` 的组**一个都不能漏**。漏一个整单被拒。

三种 `status`：

| status | 什么时候用 |
|---|---|
| `corrected` | 页面上的说明/选项与题库里的不一样，你把正确的抄了上去。**绝大多数是这个。** |
| `approved` | 页面上印的就是题库里现在这个内容，确认无误。 |
| `flagged` | 页面上根本没有这个东西，或者页面损坏看不清。**必须写 `note` 说明原因。** |

#### 6.5.1 补说明

```json
{
  "groupId": "c8t1l-g3",
  "status": "corrected",
  "instruction": "Complete the form below. Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer.",
  "note": "Summer Music Festival booking form，印刷页 11"
}
```

`instruction` 的规则：

- **只写印在页面上的那一两句说明**，12–220 字符。超了会被拒——那说明你把
  题目正文一起抄进来了。
- 一组有多句说明（`Complete the notes below.` + `Write ONE WORD ONLY for
  each answer.`）就用**一个空格连起来**写成一句。
- 必须以 `Complete` / `Choose` / `Write` / `Do the following` / `Which` /
  `Label` / `Answer` / `Match` / `Classify` / `Look at` 之一开头。
- **听力卷的说明里不许出现 `Reading Passage` / `on your answer sheet` /
  `which paragraph`**。出现了一律拒收——那是导入器从隔壁抄错的，不是页面上印的。
- 不许原样照抄 `currentInstruction`。如果页面上印的**确实**就是那个内容，
  用 `status: "approved"`（这时才允许相同）。

> **`Write your answers in boxes 9-13 on your answer sheet.` 这类不要抄。**
> 那是纸笔考试的填涂说明，机考里没有意义。只抄题型说明和字数/数量限制。

#### 6.5.2 补选项文字

```json
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
```

`options` 的规则：

- 至少 2 个；`label` 只能是单个大写字母 A–J。
- **每个选项都必须有文字**——空文字正是要修的毛病。
- 单条 ≤220 字符；不许有重复字母；不许两条文字一模一样（那是抄串行了）。
- **必须覆盖工单 `optionLabels` 里的每一个字母。**
- **必须覆盖答案键用到的每一个字母。** 脚本知道这组答案是 `['D']` 还是
  `['A','E']`，你交的列表里没有那个字母就会被拒——说明你读错框了。
- 一组同时缺说明和选项，就在同一个对象里同时写 `instruction` 和 `options`。

#### 6.5.3 `flagged`

```json
{
  "groupId": "c8t1l-g9",
  "status": "flagged",
  "note": "页面上没有选项列表。Questions 3-10 全是表格填空，第 9 题是 23 June 那一行的 \"No. of tickets\" 格。fixture 里的 single_choice、8 个空选项、答案键 'D' 三者都是错的，需要题干级修复而不是选项转写。"
}
```

`note` 至少 10 个字符，要写清楚**页面上实际是什么**。
这不是偷懒，是正确答案：题库结构错了的时候，硬编一个选项列表才是伪造。

---

## 7. 验收标准（每册收尾必须全过）

```bash
python scripts/repair/62_group_worklist.py --book 8 --status
python scripts/repair/40_apply.py --books 8
python scripts/verify_cambridge.py --baseline --health
```

| 检查 | 合格线 |
|---|---|
| 覆盖 | 本册 `--status` 显示 `N/N groups reviewed`，没有剩余 |
| 生效 | `40_apply.py` 报告本册有改动写入 |
| 门禁 | `errors` 为 0，`contentGaps` 比开工前下降 |
| 推迟率 | 本册 `flagged` 组数 ≤ 总组数的 5% |

任何一条不过 → **这一册回炉**：把不合格的工单的 `.answer.json` 删掉重做。

全部 18 册做完后：

```bash
python scripts/verify_cambridge.py --baseline --update-baseline --health
.\verify.ps1
```

---

## 8. 特殊情况

### 8.1 找不到 `Questions a-b` 标题（题在别的页上）

页码映射约 95% 命中。剩下的用扩页：

```bash
python scripts/repair/62_group_worklist.py --expand cambridge-8-test-1-listening-g0008 --by 2
```

重新渲染更宽的窗口，然后重看。**扩到 `--by 4` 还找不到才 `flagged`。**

### 8.2 图片模糊看不清

先 `--expand` 重渲一次。还不行就 `flagged`，note 里写"页面扫描模糊，某某字看不清"。
**不许猜一个像的词填上去。**

### 8.3 一组的说明跨了两页

说明通常紧跟标题，不会跨页。如果标题在上一页而选项框在下一页，
`--expand --by 1` 把两页都拿到再看。

### 8.4 选项是图表标注（Label the map / diagram）

这类的"选项"是图上的标注点，不是文字列表。如果页面上没有 A/B/C 文字列表，
按 6.5.3 `flagged`，note 里写"这是地图标注题，页面上没有文字选项列表"。

### 8.5 脚本报错崩了

把完整报错贴出来交给主会话，**不要自己改脚本绕过去**。

---

## 9. 常见拒收原因速查

| 报错里出现 | 意思 | 怎么办 |
|---|---|---|
| `taskId ... does not match` | 提交文件的 taskId 写错了 | 从工单文件里复制 |
| `printedPageNumber ... implies a front-matter offset` | 页码和本册已标定的偏移对不上 | 重新看页脚；确认没看成 PDF 页号 |
| `questionsHeadingSeen is missing` | 没抄标题 | 回去看图抄标题 |
| `questionsHeadingSeen covers ... but this task also needs` | 标题没覆盖全部题号 | 标题抄漏了，或者题在别的页 → `--expand` |
| `groups [...] are in the task but missing` | 漏交了组 | 整单补齐再交 |
| `instruction is ... characters` | 说明太长/太短 | 只抄那一两句说明，别把正文抄进来 |
| `instruction does not begin like an IELTS rubric` | 开头不对 | 你抄的不是说明，是题目正文 |
| `listening paper but the instruction cites a reading passage` | 听力卷写了阅读的说明 | 你抄错地方了，重看图 |
| `instruction is unchanged from the broken original` | 和原值一样 | 页面上确实就是这个 → 改用 `approved` |
| `option ... has no text` | 有字母没文字 | 把文字补上；页面上没有 → `flagged` |
| `the answer key uses [...] which the submitted option list does not contain` | 选项没覆盖答案字母 | 读错框了，重看图 |
| `option ... repeats the text of an earlier option` | 两条文字一样 | 抄串行了，重看图 |

---

## 10. 中断与续跑

随时可以停。所有脚本都是幂等的：

```bash
# 回来之后
python scripts/repair/62_group_worklist.py --book 8 --status   # 看进度
python scripts/repair/62_group_worklist.py --book 8 --next 1   # 继续
```

已经写进 overlay 的组会被自动跳过，不会重复问你。

---

## 11. 一个必须知道的事实：门禁会漏

随机抽 4 道门禁判定为"健康"的题去比对原书，**2 道题面完全取错了行**：

- 剑6 T1 听力 35：题库里的题面是别处的句子，页面上印的是
  `Agricultural workers came from other parts of 35 ___ to look for work.`
- 剑12 T3 听力 4：题面抄成了第 5 题那一行

**答案是对的，题面是错的**，读起来像正常英文，所以任何自动规则都抓不到。

这意味着：

- `verify_cambridge.py` 报的健康度是**上限，不是真相**。
- 你读到一页的时候，工单里的 `stems` 会列出该组各题的题面。
  **顺手和页面对一下**，发现对不上就在 `note` 里记下来：
  `"q35 题面与页面不符，页面印的是 ...（原样抄下来）"`。
  这些会汇总给主会话统一处理。
- 不要因为"门禁说它是好的"就当作没看见。

---

## 12. 不在本轮范围内（看到就跳过）

下面这些需要重新切分源文件，不是读页面转写，由主会话处理：

- 6 份阅读卷文章区完全空白：剑6 T1/T2/T3、剑7 T2/T3、剑20 T1
- 6 份阅读卷三篇文章是同一坨未切分文本：剑5 T3/T4、剑6 T4、剑9 T4、剑17 T2、剑20 T2
- 6 份写作卷题干只有占位符：剑5 T4、剑6 T1–T4、剑9 T1
- 剑21 没有听力（`听力/` 只到剑20，缺音频源）
- 剑4 缺 4 份听力原文（markdown 被截断）

工单不会给你这些，如果你在图上看到了，跳过即可。

---

## 13. 命令速查

```bash
cd "C:\Users\15pro\Desktop\MyProject\IELTS Workspace"

# —— 每册循环 ——
python scripts/repair/62_group_worklist.py --book 8              # 排单 + 渲染
python scripts/repair/62_group_worklist.py --book 8 --status     # 看进度
python scripts/repair/62_group_worklist.py --book 8 --next 1     # 取下一单
#   → 看图 → 写 <taskId>.answer.json
python scripts/repair/72_write_group_overlay.py --task <taskId> --check-only
python scripts/repair/72_write_group_overlay.py --task <taskId>
python scripts/repair/62_group_worklist.py --expand <taskId> --by 2   # 找不到标题时

# —— 每册收尾 ——
python scripts/repair/40_apply.py --books 8
python scripts/verify_cambridge.py --baseline --health

# —— 全库收尾 ——
python scripts/verify_cambridge.py --baseline --update-baseline --health
.\verify.ps1
```

---

## 14. 工作量参考

| 项 | 数量 |
|---|---|
| 待修组 | 670 |
| 工单数 | 214 |
| 需要读的页面 | 411（绝大部分已渲染，不必重跑） |
| 平均每单组数 | 4.0 |
| 平均每单页数 | 1.9 |

---

## 15. 完成的定义

全部满足才算做完：

- [ ] 18 册 `62_group_worklist.py --status` 全部显示 `N/N groups reviewed`
- [ ] `verify_cambridge.py` 的 `contentGaps` 从 1673 降到 ≤ 60
      （余下的是第 12 节那批不在本轮范围内的）
- [ ] `errors` 为 0
- [ ] 全库 `flagged` 组数 ≤ 60（5%）
- [ ] `.\verify.ps1` 全绿
- [ ] `fixtures/cambridge-health-baseline.json` 已更新
- [ ] 抽查任意 10 组，说明与选项文字与原书一致
- [ ] 抽查任意 5 道带字母答案的题，在应用里能真正选得动
