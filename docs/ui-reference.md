# IELTS on Computer UI reference

Accessed: 2026-08-22

This file records **current** official IELTS Academic computer-test behaviour used to implement Exam Runtime. Behaviour takes priority over pixel copying.

## Sources (priority order)

1. IELTS.org Academic sample tests and format pages
   - https://ielts.org/take-a-test/preparation-resources/sample-test-questions/academic-test
   - https://ielts.org/cdn/Sample-tests/ielts-academic-reading-sample-tasks-2023.pdf
   - https://ielts.org/cdn/Sample-tests/ielts-academic-writing-sample-tasks-2023.pdf
   - https://ielts.org/cdn/ielts-sample-tests/ielts-listening-sample-tasks-2023.pdf
   - https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-reading
   - https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-listening
2. Official 2025 IELTS on computer tutorials (IELTS Official YouTube)
   - Quick Guide: https://www.youtube.com/watch?v=4_dCncUPBO4 (2025-02-05)
   - Listening tutorial: https://www.youtube.com/watch?v=_O2RHxsAugg (2025-02-05)
   - Writing tutorial: https://www.youtube.com/watch?v=vteGnnQCuAs (2025-02-05)
3. IDP IELTS on computer / Familiarisation
   - https://ielts.idp.com/about/ielts-on-computer
   - https://ielts.idp.com/about/ielts-familiarisation-tests
   Note: this host resolved through a local fake-IP during this session; content taken from search snippets + official videos rather than a live walkthrough of the familiarisation app.
4. British Council
   - https://takeielts.britishcouncil.org/take-ielts/book/ielts-on-computer
   - https://www.britishcouncil.org.bd/en/exam/ielts/prepare/explaining-ielts-computer

Older 2017–2018 tutorials were **not** used as the visual source of truth when they conflict with 2025 official videos.

## Confirmed interactions (2025 official)

### Layout

- Reading: passage on the **left**, questions on the **right**. Each side has its own scrollbar.
- Writing: task prompt on the left, answer box on the right. Split can be resized. Task 1 and Task 2 may be answered in either order.
- Listening: questions fill the working area; volume control is in the **top-right**. Navigation still shows all 40 questions.
- Instructions for the current group sit in a box at the **top of the question pane**.

### Header

- Clock at the top of the screen (Reading / Writing remaining time).
- Clock turns **red and flashes at 10 minutes and 5 minutes remaining** (Reading and Writing). Official 2025 Quick Guide still demonstrates end-of-test timer behaviour; 2018 tutorial stated 10 and 5 minute warnings. We implement both 10:00 and 5:00 warnings because current official material still documents them and they remain the test-taker-facing rule set.
- Tests **automatically stop** when time finishes.
- Options / settings control: text size, colour settings, volume (Listening), test instructions.

### Navigation

- Numbered navigator along the **bottom**.
- Click a number to jump; forward/back arrows move one question.
- When a question is answered, a **line appears above** that number (2025 Quick Guide). Older videos said “under”; current source wins.
- Review flag shows the number as a **circle**.
- Navigator can be collapsed; a scrollbar appears if not all numbers fit.
- Answers can be changed until the test ends.

### Highlight / Notes (current 2025 Quick Guide)

- Select text by click-drag, then click **Highlight**.
- Click highlighted text, then **Delete Highlight** to remove.
- Select text, then click **Note**. A notes panel opens.
- Notes are a yellow notepad. Closing hides it; clicking the marked text reopens it.
- Hovering a highlight that has a note shows a small orange marker.
- Examiners do not see highlights/notes; they do not affect the score.
- Older tutorials used right-click menus. 2025 uses explicit Highlight / Note buttons. We follow 2025.

### Listening (current official)

- Recording is heard **once only**.
- **Cannot pause or stop** once the test begins (official 2025 Listening tutorial).
- Volume can be changed at any time.
- Time to read questions before each part, and some review time after each part, is built into the recording.
- At the end: **2 minutes to check all answers**, then the test stops.
- Total Listening time about **30–34 minutes** (no 10-minute transfer time; that is paper only).
- Navigation between questions is allowed; audio does not rewind or skip with navigation.
- Mock policy: `pauseAllowed=false`, `audioSeekAllowed=false`. Practice mode may pause both timer and audio together.

### Writing (current official)

- Word count is shown.
- Answers save automatically.
- Highlight and notes are available.
- No AI, rewrite, grammar assistant, or auto-correct in the real test. Runtime disables browser spellcheck and any assistive rewrite.
- Copy/paste within the test is allowed by official IDP FAQ material.

### Submit / end

- Time expiry force-submits.
- Manual submit requires confirmation (not shown as a labelled button in every official clip; we still confirm before leaving, because an accidental end would destroy a mock).
- Familiarisation tests on IDP are **untimed**; the real test is timed. Our Mock follows the real test.

## Unconfirmed / recorded differences

| Topic | Status | Implementation choice |
|---|---|---|
| Exact navy/grey hex of the 2025 chrome | Not published as a design spec | Approximate official light exam chrome, not a dark “product” theme |
| Whether the answered-mark is a 2px bar or a 1px rule | Video only | 3px bar above the number |
| Colour-scheme presets | Mentioned (“colour settings”) | Provide default / yellow-on-black / black-on-cream (common a11y set used in computer tests) |
| Hide/Resume (leave room) | In older tutorials | Not implemented in v1 (not needed for home mock) |
| Exact font | Not specified | Segoe UI / Calibri-like system UI for exam; never a marketing font |
| IDP vs British Council pixel differences | Same partner test; 2025 official videos treat one platform | One runtime |

## Timing policy used in Runtime

| Module | End condition | Warnings |
|---|---|---|
| Reading | `fixed_duration` 60 minutes | 10:00 and 05:00 remaining |
| Writing | `fixed_duration` 60 minutes | 10:00 and 05:00 remaining |
| Listening | `media_driven` then 120s check | no 10/5 min clock warnings; 2-minute check after audio |

These values come from current IELTS.org / IDP computer-test pages, not paper-test transfer rules.

## Implementation priority actually coded

1. Behaviour (timer, navigator, review, highlight, notes, force submit, listening once-only).
2. Muscle memory (bottom numbers, left passage / right questions, top clock).
3. Information layout (instruction box, split scroll).
4. Visual closeness (navy header, light workspace, yellow highlight).
5. Pixel matching: not attempted.
