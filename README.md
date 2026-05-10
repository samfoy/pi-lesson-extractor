# pi-lesson-extractor

> ⚠️ **Deprecated and unmaintained.** This extension was an early experiment in automatic lesson extraction from session transcripts. In practice the heuristic pattern detection produced too much low-signal noise to be useful. For lesson management, use pi-memory's `memory_remember(type='lesson')` directly when a real correction or gotcha emerges. Repo archived — no further fixes or releases.

A [pi](https://github.com/mariozechner/pi) extension that automatically extracts reusable problem-solving patterns from session transcripts.

## What it does

Runs pattern detection on session shutdown and session switch (`/new`), extracting:

1. **Retry loop detection** — same tool fails then succeeds with a different approach
2. **Error→fix pair detection** — error messages mapped to their resolutions
3. **User correction detection** — user messages that corrected agent behavior
4. **Confirmation detection** — user messages that validated an approach (positive signal)

Candidates accumulate with confidence scores and auto-promote to permanent [pi-memory](https://github.com/samfoy/pi-memory) lessons when they reach threshold.

## Installation

```bash
pi install @samfp/pi-lesson-extractor
```

Requires `@samfp/pi-memory` as a peer dependency (for lesson promotion).

## How it works

### Lifecycle

- **`session_before_switch`** — runs fast heuristic pattern detection on current session entries before `/new` or `/resume`
- **`session_shutdown`** — same extraction on process exit
- **`session_start`** — checks for pending candidates, runs auto-promotion pipeline, shows notification count

### Auto-promotion pipeline

Candidates that meet promotion criteria (high confidence, seen across multiple sessions) are automatically promoted to permanent pi-memory lessons on the next session start.

### Tools

| Tool | Description |
|------|-------------|
| `lesson_candidates` | List pending lesson candidates by status |
| `lesson_accept` | Promote a candidate to a permanent lesson |
| `lesson_reject` | Reject a candidate permanently |

### Commands

| Command | Description |
|---------|-------------|
| `/lessons-review` | Interactive review of pending candidates |

## Storage

Candidates are stored in a SQLite database at `~/.pi/agent/lesson-extractor/candidates.db`.

## License

MIT
