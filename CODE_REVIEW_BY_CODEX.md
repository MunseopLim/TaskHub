# CODE REVIEW BY CODEX

- Review date (local): `2026-02-19 11:59:15 +09:00`
- Review date (UTC): `2026-02-19 02:59:15 UTC`
- Reviewed commit (HEAD): `995a18f1e7be803038e9fcacda73c590b41a741c`
- Scope: `staged` changes only (`git diff --cached`)
- Reviewed files:
  - `src/extension.ts`
  - `src/macroExpander.ts`
  - `src/numberBaseHoverProvider.ts`
  - `src/sfrBitFieldParser.ts`
  - `src/test/extension.test.ts`
- Validation run:
  - `npm run check-types` (pass)
  - `npm run lint` (pass)

## Findings (ordered by severity)

### LOW - Debounced callbacks are not cancellable on watcher disposal
- Locations:
  - `src/extension.ts:1146`
  - `src/extension.ts:2649`
  - `src/extension.ts:2738`
- Issue:
  - `debounce` returns only an invoke function; there is no cancel/flush API.
  - If a timer is pending when watchers are disposed (or extension lifecycle changes), the delayed `refresh()` can still run afterward.
- Impact:
  - Minor lifecycle race / redundant refresh work. Low risk for correctness, but avoidable side effects.
- Recommendation:
  - Return `{ run, cancel }` (or equivalent) from `debounce` and call `cancel()` in watcher disposal paths.

### LOW - Missing-file cache in `loadTypeConfig` does not avoid sync fs calls
- Location: `src/numberBaseHoverProvider.ts:1324`
- Issue:
  - Function always executes `fs.statSync(configFilePath)` before it can reuse cache.
  - In the absent-file path, catch stores `{ mtime: -1 }`, but next hover still performs `statSync` again.
  - The comment says this avoids repeated stat calls, but current flow does not.
- Impact:
  - No effective optimization for the common "no taskhub_types.json" case; minor synchronous I/O overhead on hover.
- Recommendation:
  - Either:
    - implement a true miss-cache strategy (with controlled recheck), or
    - keep current behavior and update the comment to avoid misleading intent.

## Open Questions / Assumptions

- Assumed intended behavior: watcher event coalescing (200ms debounce) is acceptable, and eventual consistency is preferred over per-event immediate refresh.

## Change Summary

- Added `debounce` helper and applied it to workspace/media file watchers.
- Hoisted regex/pattern constants to module scope in:
  - `src/macroExpander.ts`
  - `src/numberBaseHoverProvider.ts`
  - `src/sfrBitFieldParser.ts`
- Added mtime-based type-config cache in `NumberBaseHoverProvider.loadTypeConfig`.
- Added `debounce` unit tests in `src/test/extension.test.ts`.

## Residual Risks / Test Gaps

- No integration test verifies watcher refresh behavior under bursty file-system events.
- No tests for cache behavior in `loadTypeConfig` (miss, invalid JSON, mtime update).
