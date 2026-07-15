# Plan: Prompt-level injection defense via spotlighting

## Summary

Add `src/defense/` module implementing Microsoft Spotlighting (delimiting variant) + adversarial system prompt preamble. Integrate into DB and ship tool output pipelines. Zero dependencies.

## Files to create

### 1. `src/defense/spotlight.ts` — Core spotlighting module

Exports:
- `SpotlightingPolicy` — versioned config (delimiters, preamble text, method)
- `spotlightingPreamble()` — returns adversarial system prompt fragment for agent
- `spotlight(text)` — wraps untrusted text in randomized delimiters, returns `{ wrapped, delimiter }`
- `spotlightValue(value)` — recursively spotlights string leaves in arbitrary JSON
- `DEFAULT_POLICY` — default policy instance

Implementation details:
- Generates crypto-random delimiters from `node:crypto.randomUUID()` on policy init
- Delimiter format: `<<<UNTRUSTED:random-token>>>...<<<END_UNTRUSTED:random-token>>>`
- Preamble includes few-shot example showing model ignoring injected instructions
- Policy is versioned (bump version to change preamble/delimiters)

### 2. `src/defense/index.ts` — Barrel export

Re-exports everything from `spotlight.ts`.

### 3. `test/defense/spotlight.test.ts` — Unit tests

Tests:
- `spotlight()` wraps text with unique delimiters per policy instance
- `spotlightValue()` recurses into objects/arrays, preserves non-strings
- `spotlightingPreamble()` returns non-empty string with version marker
- Policy versions produce distinct delimiters
- Empty/null/undefined text handled gracefully
- Spotlighted text does not contain the delimiter as substring (no collision)
- `spotlightValue()` on nested objects spotlights all leaf strings

## Files to modify

### 4. `src/tools/db/index.ts` — Wrap DB query results

In `registerDB()` execute handler:
- Import `spotlightValue` and `spotlight`
- For `inspect`, `browse`, `query` actions: wrap `details.rows` and any text fields via `spotlightValue()`
- For `migration_status`: wrap journal entry details via `spotlightValue()`
- Wrap `content[].text` in spotlight delimiters for externally-sourced fields

### 5. `src/tools/ship/index.ts` — Wrap ship operation results

In `registerShip()` execute handler:
- Import `spotlightValue`
- After handler returns `ToolResult`, spotlight `details` recursively
- Wrap `content[].text` for externally-sourced fields

### 6. `src/index.ts` — Export spotlighting for consumers

Add re-export of `src/defense/index.ts` so operators can import `spotlightingPreamble()` for their agent configuration.

## Verification

1. `npx tsc --noEmit` — typecheck passes
2. `npx vitest --run test/defense/` — spotlight tests pass
3. `npx vitest --run` — existing test suite still green
4. Manual: inspect `spotlightingPreamble()` output, verify it's suitable for agent system prompt
