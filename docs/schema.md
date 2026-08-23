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

## Scoring

`acceptedAnswers` is an explicit list. The scorer only trims, folds case, and collapses whitespace. Importer (or the human who wrote the JSON) must expand colour/color, (the) library, etc.

QuestionGroup `scoringPolicy`:

- `per_question`
- `in_either_order` (dedupe user answers against the group's accepted set)

## Session AI contract

Every answer stores `questionId`, `questionType`, `value`. Events store navigation and submit timestamps so later analysis can recover passage timing without keystroke logs.
