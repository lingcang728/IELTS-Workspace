# Exam / Session Schema v1

Both Exam JSON and Session JSON require `"schemaVersion": 1`.

## Highlight storage (frontend-only text layer)

Offset unit is **unicode_code_point** after **Unicode NFC**.

Hash:

```
SHA-256( UTF-8( NFC(normalizedText) ) )
```

Rust persists highlight objects as opaque JSON. It must not recompute offsets or hashes.

Each highlight:

- targetId
- startOffset / endOffset
- offsetUnit = unicode_code_point
- textHash
- contextBefore / contextAfter

Recovery: hash match → offsets; else unique context/excerpt; else mark invalid. Never silently highlight the wrong span.

## Exam JSON fields

Top level: `schemaVersion`, `id`, `module` (`reading` | `listening` | `writing`), `title`, `policy.endCondition` (`type` = `fixed_duration` + `durationMs`, or `media_driven`), `sections[]`.

`policy` may also carry `pauseAllowed`, `audioSeekAllowed`, `forceSubmit` — the exam runtime derives mock behaviour from these (see `docs/ui-reference.md`).

Section: `questionGroups[]`. QuestionGroup:

- `id`, `instruction` (HTML-ish, rendered escaped), `questionType` (`completion` | `single_choice` | `multi_choice` | `matching` | `true_false_ng` | `yes_no_ng` | `labelling` | …), `scoringPolicy`
- `questions[]` — each: `id` (letters/digits/`-`/`_` only — it joins the session key and mistake-record id), `number` (1–40), `type` (overrides `questionType`), `prompt`, `acceptedAnswers`, `options` (per-question `[{id,label,text}]`; takes precedence over `sharedOptions`)
- `sharedOptions` — option pool shared by every question in the group
- `acceptedAnswers` — group-level answer pool; used by `in_either_order` and as fallback when a question has none
- `layoutHtml` — table/flow-chart template with `{{q:question-id}}` placeholders
- `wordBank`, `imageAsset` — optional, `imageAsset` is a sanitized relative path under the asset roots
- `repairSource` — provenance written by `scripts/repair/`; informational only

## Scoring

`acceptedAnswers` is an explicit list. The scorer only trims, folds case, and collapses whitespace. Importer (or the human who wrote the JSON) must expand colour/color, (the) library, etc.

QuestionGroup `scoringPolicy`:

- `per_question`
- `in_either_order` (dedupe user answers against the group's accepted set)

Multi-select: under `in_either_order` the group pool is consumed one slot per question. Under `per_question` a single multi-select slot stores its letters joined `"B|C"` (sorted, pipe-separated) in `acceptedAnswers` — the user's array answer is sorted and joined the same way before comparison.

## Session JSON fields

Top level: `schemaVersion`, `id` (`s-…`, `[A-Za-z0-9_-]+`), `examId`, `examTitle`, `module`, `mode` (`mock` | `practice`), `status` (`created` | `in_progress` | `submitted` | `aborted` | `interrupted` — `aborted` is a legacy value kept in the whitelist so old files still validate; `interrupted` is still written when a resumed session's `examRevision` no longer matches the current exam), `startedAt` / `updatedAt` (ISO), `remainingMs`, `examRevision`, `answers` (`questionId` → `value`), `audio` (`positionMs` + `partIndex` 0–3, or null), `writing`, `highlights`, `notes`, `events`, `integrity` (blur/focus event counts), `fontScale`, `colorScheme`, `saveError`.

## Session file lifecycle

Writes are atomic: `*.json.tmp` → fsync → `*.json.bak` copy of the previous file → `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` rename. Reads fall back `.json` → `.json.bak` → `.json.tmp`; a corrupt candidate is moved to `sessions/quarantine/{ms}-{name}` with a `.reason.txt` note, and a valid fallback is restored over the main file. `discard_session` removes all three siblings; `archive_session` moves `.json`+`.json.bak` under `sessions/archive/` and drops `.tmp`. The same chain is used by `audio/bindings.json` and `store` records (`mistakes`/`vocab`/`plans`/`feedback`), whose quarantine lives in `<kind>/quarantine/`.

## Session AI contract

Every answer stores `questionId`, `questionType`, `value`. Events store navigation and submit timestamps so later analysis can recover passage timing without keystroke logs.
