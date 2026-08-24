# 题库修复管线（Phase 1）

把 MinerU 从剑桥 PDF 提取的 markdown，还原成可用的题面，写回
`fixtures/cambridge/*.json`。每个阶段都幂等可重跑，产物落在
`data-dev/repair/`，**只有 `40_apply.py` 会改 fixtures**。

```
00_index_sources.py    → data-dev/repair/source-index.json
10_parse_questions.py  → data-dev/repair/parsed/{exam-id}.json
20_extract_transcripts.py → fixtures/transcripts/{exam-id}.json
30_part_offsets.py     → 写回 exam json 的 Part 边界（待建）
40_apply.py            → 合并 overlay + parsed → fixtures（待建）
```

合并优先级：**`overlay(人工)` > `parsed(自动)` > `现有 fixtures`**。
`fixtures/overlays/` 永远不被脚本覆盖，这是能反复重跑解析器的前提
（见 `AGENTS.md` 第 4 条）。

```powershell
python scripts/repair/00_index_sources.py                 # 全库
python scripts/repair/10_parse_questions.py --books 8,6    # 批次 0
python scripts/repair/20_extract_transcripts.py
```

---

## 批次 0 校准结果（剑 8 + 剑 6，2026-08-24）

计划选这两册是因为它们是损坏率的两个极端（剑 8 最好、剑 6 最差），
用来标定解析规则与置信度阈值，并量出 HIGH 的真实占比。

### 置信度分布

| | 批次 0（剑8+剑6，640 题） | 全库（5600 题） |
|---|---|---|
| HIGH（自动通过 + 10% 抽检） | 326 (51%) | 2737 (48%) |
| MEDIUM（必须人工过目） | 162 (25%) | 1472 (26%) |
| LOW（必须人工重写） | 152 (24%) | 1391 (25%) |
| **需要人工** | **314 (49%)** | **2863 (51%)** |

### 结论：人工工作量比计划估计的多

计划假设 HIGH 能占到六成，人工要看的从 2391 降到约 1000 题、5–6 小时。
**实测 HIGH 只有 48%**，需要人工处理的是 **2863 题**。按每题 20 秒
（MEDIUM 过目）到 60 秒（LOW 重写）估算：

- MEDIUM 1472 题 × 20s ≈ **8 小时**
- LOW 1391 题 × 60s ≈ **23 小时**
- 合计约 **31 小时**，不是 5–6 小时。

排序仍按计划：剑 4–15 先修（日常练习主力），剑 16–21 后修（十月才用）。

### 校准过程中修掉的解析器缺陷

这些都是拿真实数据量出来的，不是想出来的：

1. **选项列表抓错成文章段落**。阅读文章的段落标记就是 `A`、`B`、`C`，
   和选项列表长得一模一样，只是"选项"有 800 字。改成给候选列表打分：
   选项文本要短，且标签集合要能覆盖答案键。
2. **`starts lowercase` 是个坏启发式**。`a description of an early
   timekeeping invention…` 这类段落配对题干本来就小写开头，每份卷子
   平白多推 4 题给人工。改成只在首词不是常见小写起始词时才报。
3. **`|` 和 `•` 被当成 OCR 异常字符**。`|` 是本脚本自己拼表格用的分隔符，
   `•` 是剑桥笔记填空的正常项目符号。这一条误报了 92 题。
4. **题号补全会串题**。题号丢失时从上一题结尾接着取，若取到的题干和
   前一题完全相同，那是没找到，不是猜到——降为 LOW。
5. **题干吞掉了下一题的选项梯**。答案是单词却在题干里出现
   `A … B … C …` 阶梯，说明越界了。
6. **丢空格的 OCR**（`aswith most ganzfeldstudies`、`theamount of`）与
   落单字母（`response t .which`）此前完全没被发现，现已加入检测。

### 批次 0 的意外发现：答案键本身也是坏的

计划把 `acceptedAnswers` 当作可信锚点。批次 0 抽检时发现
`cambridge-8-test-1-listening` 第 2 题的答案是 `张听力录音光盘`，
`cambridge-11-test-1-listening` 的前几题是 `口 2 ×`、`二 3 ×`、`一`。

全库扫描：**348 处答案含中日韩字符，涉及 182 道题**——扫描版答案页的
水印和表格线被 OCR 当成了答案。英文雅思答案永远不可能是中文，所以这条
已经加进 `verify_cambridge.py` 作为硬损坏信号。

**影响**：这 182 道题不能用答案键当锚点，必须回原书核对答案本身，
不只是题面。损坏基线因此从 3107 升到 3289。

### 已知的数据源缺口

| 问题 | 影响 | 处置 |
|---|---|---|
| 剑 4 的 MinerU markdown 缺听力原文附录（输出被截断到 128K，其余册 240–320K） | 剑 4 无 audioscript | 需要用 `G:/MinerU` 对 `教材/剑桥雅思真题4.pdf` 重跑 |
| 答案位置标记 `Q1`..`Q40` 只有 1331/2560（51%） | 复盘时部分题指不出"答案在这一句" | 剑桥印在页边，MinerU 丢了近一半；无解，脚本如实报告 `missingMarkers` |
| 10 份听力卷有 section 未干净切开 | 精听按 Part 定位会偏 | 记录在 `thinSections`，人工审阅时可调 |
