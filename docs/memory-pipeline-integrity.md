# Memory pipeline integrity

This repository treats source provenance and withdrawal as database contracts rather than prompt conventions.

## Production wiring

`database.js` installs the provenance schema, dependency triggers, review queue, runtime views, and operation tables in one migration. Startup calls `assertContracts`; a missing trigger or runtime view stops startup instead of silently weakening reads. `index.js` starts the diagnostic monitor and `tasks/cron.js` records actual Archivist and Scribe invocations.

Scribe writes each fragment and its checked source in one transaction. Fragment indexing uses the same HTTP Chroma bridge as retrieval. A malformed or failed index response leaves the row unindexed and visible in health diagnostics so it can be retried.

## Evidence boundaries

- `user_fact`: exact quotation from a user-authored message in one real conversation context.
- `interaction_pattern`: how the user communicates with the companion; it is not automatically a cross-context personality trait.
- `ai_opinion`: the companion's interpretation, kept distinct from user testimony.
- `fiction`: role-play, game, cinema, or creative material.
- `third_party`: information about somebody else or imported material.
- `unverified`: no source contract has been established.

Entity links also have separate meanings. Verified fact ownership, organizational/topic association, interaction context, and manual rejection are not interchangeable. A rejected link is a tombstone and automated classification cannot recreate it. Similar names, aliases, and shared fragments can create a merge proposal; only an explicit identity decision executes a merge.

## Withdrawal and review

Database triggers enqueue dependent profiles, episodes, user-model entries, patterns, and sagas whenever relevant source content or ownership changes. Runtime views hide queued outputs or mask their derived fields. The original rows remain available for audit and repair.

The authenticated `/api/memory/pipeline` API provides health diagnostics, pending reviews, exact-source review, replacement from currently quoted `user_fact` fragments, and retirement. Every action checks an optimistic revision in the same transaction and records before/after state locally. Saga replacement is intentionally unavailable until a reviewed episode rebuild can establish its lineage; retirement remains available.

Legacy rows are preserved during upgrade. Rows without proof are queued or masked; the migration never fabricates exact quotations. A quotation proves the source text and author, not the semantic correctness of a model summary, so ambiguous interpretations still require human judgment.

## Verification

`npm test` runs isolated SQLite tests against production routes and services. It covers fresh-install ingress, Scribe, event listeners, recall, source mutation withdrawal, partial episode coverage, failed vector indexing, semantic evidence checks, duplicate-identity proposals, authenticated review exits, concurrent revision changes, and upgrade from the previous public schema. External LLM and vector transports are substituted with synthetic fixtures; no personal memory data is used.

`npm run test:smoke` performs an additional offline fresh-database smoke test. It skips the real Chroma heartbeat by design; service availability belongs in deployment health monitoring.
