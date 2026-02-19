# CODE REVIEW BY CODEX

- Reviewed commit (HEAD): `727902d4e50d43b81b8cbb47f8303b59d89f0ac4`
- Scope: repository-wide review (`src/*.ts`, schemas, tests, command/runtime paths)
- Validation run:
  - `npm run check-types` (pass)
  - `npm run lint` (pass)
  - `npm test` (pass, 434 tests)

## Findings (ordered by severity)

### HIGH - Custom type config drops built-in type definitions
- Location: `src/structSizeCalculator.ts:357`
- Related behavior: `src/structSizeCalculator.ts:335`
- Issue:
  - `StructSizeCalculator.loadTypeConfig` replaces `types` with `configJson.types` instead of merging with defaults.
  - When a user supplies only a few custom types, built-in types are no longer present in `this.typeConfig.types`.
  - Missing built-ins then fall through to the generic fallback `{ size: 4, alignment: 4 }`, producing wrong sizes (for example, `char` becomes 4 bytes).
- Impact:
  - Struct layout and padding results become incorrect for most primitive types whenever custom config is partially defined.
- Recommendation:
  - Merge defaults and custom types:
    - `types: { ...DEFAULT_TYPE_CONFIG.types, ...(configJson.types || {}) }`

### HIGH - Union parser counts braces inside comments/strings and can terminate early
- Location: `src/registerDecoder.ts:333`
- Issue:
  - `parseRegisterFromUnion` increments/decrements `braceDepth` for every `{`/`}` character without skipping comments or string/char literals.
  - A comment like `// }` inside a union can reduce depth to zero and return `null` before bit-fields are parsed.
- Impact:
  - Register decoding hover fails unpredictably for valid C/C++ code that contains braces in comments/strings.
- Recommendation:
  - Apply the same comment/string-aware brace scanning approach already used in `parseRegisterFromStruct`.

### MEDIUM - Deleting one favorite can delete multiple entries unintentionally
- Location: `src/extension.ts:3053`
- Issue:
  - `taskhub.deleteFavorite` filters entries by only `path` + normalized `line`.
  - If multiple favorites point to the same file/line with different titles/groups/tags, deleting one removes all matching entries.
- Impact:
  - Data loss in `favorites.json` from a single delete action.
- Recommendation:
  - Use a stricter identity for deletion (for example `title + path + line + group`), or add a stable ID per favorite entry.

### LOW - Preset "Keep both" behavior conflicts with UI wording
- Locations:
  - `src/extension.ts:3386`
  - `src/extension.ts:229`
- Issue:
  - UI says "Keep all actions (duplicates allowed)", but `mergeActions(..., 'keep-both')` removes conflicting IDs via `filterConflictingItems`.
- Impact:
  - Users can believe duplicates are kept while conflicting preset actions are silently dropped.
- Recommendation:
  - Either update UI text to reflect current behavior, or implement true keep-both semantics with deterministic conflict handling.

## Residual Risks / Test Gaps

- No tests found for duplicate favorite deletion behavior in command flow.
- No tests found for brace-in-comment cases in `parseRegisterFromUnion`.
- No test currently catches primitive type regression when partial custom type config is provided.
