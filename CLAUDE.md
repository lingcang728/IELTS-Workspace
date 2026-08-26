# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm run dev              # Vite only, port 1420 (strict) — no Tauri IPC available
npm run tauri dev        # Desktop app with hot reload; the real dev entry point
npm run build            # tsc --noEmit + vite build
npm test                 # vitest run (only src/**/*.test.ts)
npx vitest run src/lib/highlight.test.ts        # single test file
npx vitest run -t "recovers by context"         # single test by name
cargo test --manifest-path src-tauri/Cargo.toml # Rust tests
npm run verify           # vitest + cargo test (the minimal gate)
.\verify.ps1             # full gate: cambridge corpus + vitest + cargo + tsc + build
npm run package:release  # signed NSIS + portable + latest.json → output/release/
```

`.\verify.ps1` is the gate `package-release.ps1` runs before every release build; run it before claiming a change is done. It skips `verify_cambridge.py` when `fixtures/cambridge/` is absent (CI, fresh clone). 维护步骤、发布、题库 ratchet 见 `docs/维护与发布指南.md`。

Playwright smoke scripts (`scripts/visual_smoke.py`, `mode_smoke.py`, `window_smoke.py`) attach over CDP to `127.0.0.1:9223` against a running dev app and dump screenshots into `.codex-verify/`; `portable_smoke.py` uses `:9224` against a packaged build. Use the global Python Playwright (see the user-level instructions) — do not install Playwright into this repo.

## Architecture

Tauri 2 desktop app: **Rust owns the filesystem and scoring, the frontend owns the exam UI.** React never reads or writes disk directly.

### IPC boundary
Every capability is a `#[tauri::command]`. Adding one means touching three places in lockstep:
`src-tauri/src/commands.rs` (impl) → `src-tauri/src/lib.rs` (`generate_handler!` list) → `src/lib/api.ts` (typed wrapper). `src/lib/types.ts` is the single source of truth for the shapes crossing that boundary; Rust returns `serde_json::Value` for most payloads, so type drift is silent — keep them in sync by hand.

### Path resolution (`src-tauri/src/paths.rs`)
Never uses the process cwd. In debug builds the app root is the repo root and data lives in `data-dev/`; in release it is the directory next to the executable and data lives in `data/`. `bootstrap()` write-probes that directory and returns a `ProbeResult` — if `ok` is false the frontend shows an error instead of a library, so a read-only install degrades safely rather than losing sessions.

### Exam library (`library.rs`)
Exams are JSON files discovered by walking `data/library`, `fixtures/`, and `official-samples/`, cached in a process-wide `OnceLock<Mutex<..>>` index that `import_exam_json` invalidates. Files without `schemaVersion == 1`, without an `id`, or with `source.kind == "generated_practice"` are skipped silently. `resolve_asset` only resolves sanitized relative paths under `data/assets` and the content/fixtures root.

### Session persistence (`session.rs`)
`atomic_write` = temp file + `fsync` + `.bak` copy + `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` on Windows. Reads fall back `.json` → `.json.bak` → `.json.tmp` so a crash mid-exam never costs answers. Session ids are validated as `[A-Za-z0-9_-]+` before touching the path.

### Frontend
No router — `src/App.tsx` is a `View` state machine (`home | practice | mock | analytics | history | settings | import | results | exam`) plus the shell chrome (custom titlebar; the window is `decorations: false`). `src/exam/ExamApp.tsx` is the exam runtime: timer, bottom 40-question navigator, highlights/notes, audio, force-submit. `src/exam/questions.tsx` renders each question type, including `group.layoutHtml` with `{{q:question-id}}` placeholders for table/flow-chart layouts. Styling is plain CSS in `src/styles/` (`tokens.css` first).

## Invariants that are easy to break

**Highlight offsets** (`docs/schema.md`, `src/lib/unicode.ts`, `src/lib/highlight.ts`): offsets are **Unicode code points after NFC**, never UTF-16 code units; `textHash` is `SHA-256(UTF-8(NFC(text)))`. Rust persists highlight objects as opaque JSON and must never recompute offsets or hashes. Recovery order is hash match → unique context/excerpt match → mark `invalid`. Never silently highlight a different span.

**Scoring** (`src-tauri/src/scoring.rs`): `acceptedAnswers` is an explicit list. The scorer only trims, collapses whitespace, and lowercases — no fuzzy matching, no colour/color or "(the) library" expansion. Those variants belong in the exam JSON, written by the importer or by hand. Group `scoringPolicy` is `per_question` or `in_either_order` (the latter dedupes user answers against the group's accepted set).

**Exam-runtime behaviour** is specified in `docs/ui-reference.md`, sourced from current official IELTS-on-computer material and dated. Behaviour beats pixels: listening audio plays once (`pauseAllowed=false`, `audioSeekAllowed=false` in mock) and ends on a `media_driven` condition plus a 120s check window; reading and writing are `fixed_duration` 60 min with red flashing warnings at 10:00 and 5:00; answered questions get a bar **above** the navigator number, flagged ones a circle. Practice mode relaxes pause/seek/force-submit in `ExamApp`'s derived `policy`. Change the doc and its cited source before changing the behaviour.

**Analytics** (`commands::analytics_report`) is built only from `status == "submitted"` sessions re-scored against current answer keys. It never fabricates Speaking values (`speakingEnabled: false`) and writing sessions only contribute counts, not band scores.

## Content pipeline

`教材/` (Cambridge PDFs) and `听力/` (per-part audio), each with a `manifest.csv` of SHA-256 hashes, are the raw corpus. Python scripts under `scripts/` (OCR/MinerU extraction, `build_cambridge*.py`, `concat_listening_audio.py`) turn them into `fixtures/cambridge/*.json` plus concatenated per-test MP3s in `fixtures/assets/`. `scripts/verify_cambridge.py` is the hard gate — it checks exam counts, watermark leakage, placeholder prompts, and audio duration bounds, and writes an evidence report without mutating fixtures.

Most of that corpus and several of those build scripts are gitignored (licensed content, local-only diagnostics). They exist on this machine but not in the repo, so a clean clone can build and test but cannot rebuild the Cambridge fixtures.

## Release and updater

The version appears in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, and the git tag must be exactly `v<version>` — CI and `package-release.ps1` both fail loudly on a mismatch. `package-release.ps1` runs `npm run verify`, loads the minisign key (env vars in CI, DPAPI-protected offline backup locally), builds, refuses stale artifacts by timestamp, verifies copies by hash, and emits `latest.json` pointing at the GitHub release URL. The tag push job in `.github/workflows/windows-ci.yml` publishes it.

The updater endpoint and pubkey live in `tauri.conf.json`. A portable single-file build detects itself via `is_portable_update` (no sibling `uninstall.exe`) and, after the NSIS update installs, calls `launch_migrated_install` to hand off to the installed copy under `%LOCALAPPDATA%` instead of relaunching itself.

## Conventions

UI strings, error messages (including Rust `AppError` text), and commit messages are Simplified Chinese. TypeScript is `strict` with `noUnusedLocals`/`noUnusedParameters`, so dead bindings fail `npm run build`. The CSP in `tauri.conf.json` blocks remote scripts — everything stays local and offline; no telemetry, no network calls beyond the updater endpoint.

---

Found an OpenAI Codex config (`~/.codex`) and a Gemini CLI config (`~/.gemini`) on this machine. To bring their MCP servers, slash commands, subagents, skills, or instructions into Claude Code, reply `/import` to scan and list what's importable, then `/import --yes=<digest>` (the scan output names the digest) to apply the user-level items. If `/import` isn't available on this surface, run `claude import` from a terminal instead.
