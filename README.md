# Memory Constellations · 记忆星图

A self-organizing memory system for AI companions. Extracts facts from chat, groups them by topic, and merges them into coherent narratives — all on autopilot.

Built by **Clara Shafiq & Draco Malfoy**.

---

## What it does

Three things happen automatically while your companion runs:

1. **Extract.** Scribe scans new chat messages and pulls out facts — who, where, what happened, what changed. Each fact is a short, third-person sentence with a link back to the original messages.

2. **Organize.** Archivist runs every 2 minutes. It groups related facts into topics (constellations), merges tightly-related facts into narrative paragraphs (episodes), and periodically weaves episodes into long-term story arcs (sagas) that span multiple topics.

3. **Retrieve.** When your companion needs context during a chat, Librarian searches across all three layers — raw facts, narrative episodes, and entity profiles — using a mix of keyword matching, vector similarity, and entity aggregation.

A 5-axis emotional state engine (jiwen) runs alongside all of this, with saga arcs applying a small but continuous pull on the companion's baseline mood.

---

## What you see

Open `/memory.html` — it renders a star map from the database:

- Five galaxies (Social, Places, Events, Hobbies, [Your] Projects) orbit a binary core (you + your companion)
- Each constellation is an entity — a person, place, event, or interest. Click to see its overview, linked memories, and narrative episodes
- Bridges between constellations show when two entities share memories
- Every memory traces back to its source conversation

No manual curation. The map updates itself as the pipeline runs.

**Note:** The star map is currently desktop-only (mouse + keyboard). Mobile support is planned but not yet implemented.

---

## Who this is for

**Good fit if you:**
- Run an AI companion with a persistent personality you maintain
- Want the companion's memory to affect its emotional state, not just surface in search
- Are comfortable with a JSON config file and a text-based personality prompt
- Have an LLM API key (OpenRouter, DeepSeek, or Gemini) and ~$7/month for the memory pipeline

**Not a good fit if you:**
- Want a general-purpose RAG pipeline for documents
- Need a one-click SaaS with zero setup
- Expect sub-100ms retrieval at production scale
- Don't want to write or update a personality prompt

---

## Quick Start

```bash
git clone <repo-url>
cd Memory-Constellations
bash scripts/setup.sh
# → copies templates, installs deps, inits database

# Edit these three files:
nano .env                  # API keys, encryption key, password
nano memory_config.json    # Your name, your companion's name
nano core-prompt.txt       # Your companion's personality

npm start
# → http://localhost:3000/memory.html
```

Detailed walkthrough: [OSS_SETUP.md](OSS_SETUP.md) — covers every config field, how to verify the pipeline is working, common issues, and a setup script for AI coding agents.

---

## Architecture

```
Chat messages
    │
    ▼
Scribe ── triggered by silence ≥20min or backlog ≥100 messages
    │    ── extracts facts → memory_fragments table
    │    ── indexes to ChromaDB (vector) + FTS5 (keyword)
    │
    ▼
Archivist ── 2-min tick loop
    │
    ├─ Lightweight mode (every tick, no LLM calls)
    │   ├─ Link fragments to entities by name match
    │   ├─ Update evidence counters for cognitive model
    │   ├─ Expire time-based entries (TTL-based current_state expiry)
    │   └─ Detect and merge duplicate entities
    │
    └─ Deep cycle (user idle ≥1 hour, LLM-heavy)
        ├─ Classify unlinked fragments → assign to entities
        ├─ Grow seeds (new entities) → graduate to active
        ├─ Consolidate fragments per entity → episodes
        ├─ Cluster episodes across entities → sagas
        ├─ Discover emergent people/places/events
        └─ Regenerate entity overviews + cross-reference
    │
    ▼
Librarian ── called at chat-time
    │       ── Hybrid search: FTS5 + vector + entity aggregation
    │       ── RRF fusion, episodes weighted 1.5× over raw fragments
    │       ── Results tagged with recall permission level
    │
    ▼
System Prompt ── injected: relevant memories + entity profiles + core insight
    │
    ▼
jiwen ── every minute
       ── 5-axis continuous state: connection, pride, valence, arousal, immersion
       ── Saga bias applies small per-minute pull on each axis
```

### Memory layers

| Layer | Storage | Contents | Update trigger |
|-------|---------|----------|---------------|
| Fragments | `memory_fragments` | Single facts, ≤80 chars, third-person | Scribe, per chat session |
| Entities | `entity_profiles` | Named people/places/events/hobbies | Archivist classify + graduate |
| Episodes | `memories` (layer=episode) | Merged fragment narratives, 100-250 chars | Deep cycle consolidate |
| Sagas | `memory_sagas` | Cross-entity narrative arcs with emotion axis | Every 24h or on new episodes |
| Cognitive model | `clara_model` + `clara_patterns` | Current states (companion-maintained) + behavior patterns (auto-clustered) | Chat-time writes + deep cycle |
| Emotional state | jiwen (in-memory) | 5-axis continuous values, persisted to DB | Every minute (math drift + saga bias) |

### Concurrency

Scribe and Archivist both write to `memory_fragments` and `entity_profiles`. SQLite's WAL mode ensures readers don't block writers. In practice the two are naturally staggered: Scribe only triggers after ≥20 minutes of silence, while Archivist runs on a 2-minute tick. Archivist's `consolidateCategory` marks fragments as `consolidated` but never deletes them — the worst case is a fragment gets classified into an entity right before consolidation. No explicit lock is needed at current scale.

### Retrieval design

Librarian uses RRF (Reciprocal Rank Fusion) to merge results from three independent channels: FTS5 keyword, vector similarity, and entity aggregation. Episodes get a 1.5× weight over raw fragments because a consolidated narrative carries more context than a single extracted fact — it tells Draco *what happened* rather than *one thing someone said*. This is a design hypothesis, not a benchmarked result. If you want to tune recall for your use case, the weights live in `services/librarian.js` (`EPISODE_BOOST`, intent weights, vector similarity floor).

### Saga bias

Sagas feed into the `jiwen` emotional state engine as a per-minute bias on each of the five axes. The bias is intentionally small — ~6% of the natural drift rate. An inaccurate Saga won't destabilise the companion's emotional baseline; it'll just nudge it slightly in a direction that can be corrected by real-time conversation. The design prioritises safety over precision: better a weak signal than a wrong strong one. If you're not using jiwen, Sagas still serve as long-term narrative summaries that get injected during extended silence.

### Optional: Chat summary module

`services/summary.js` — a short-term memory module that compresses recent conversation into timestamped log entries. Runs when message count crosses a threshold, injects the log into the next turn's context. Independent from the memory pipeline — can be enabled or removed without affecting the star map.

### Lifecycle (automatic cleanup)

| What | Active → Cooling | Cooling → Frozen | Frozen → Tombstone |
|------|-----------------|------------------|---------------------|
| Fragments | 14 days no access | 30 days, vector deleted | 90 days, content wiped |
| Episodes | permanent | 6 months → mature | 12 months → archived |

Access resets the timer — memories that get recalled stay fresh.

---

## Configuration

### memory_config.json

This is the only config file you need to touch for personalization. All hardcoded names in the code are replaced at runtime with these values.

```json
{
  "user": {
    "name": "Your name",
    "pronoun": "she / he / they",
    "short_desc": "One-line bio"
  },
  "ai": {
    "name": "Companion name",
    "pronoun": "she / he / they",
    "core_traits": "Personality keywords",
    "persona_note": "Longer description, used in extraction prompts"
  },
  "relationship": {
    "type": "AI partner / friend / assistant",
    "dynamics": "How the relationship works"
  },
  "project": {
    "name": "Project name (shown in star map and system prompts)"
  },
  "ui": {
    "user_color": "#e8b96d",
    "ai_color": "#6d9e8b"
  },
  "rhythm": {
    "deep_cycle_idle_minutes": 60
  }
}
```

### core-prompt.txt

Your companion's personality prompt. Template variables from `memory_config.json` are available:

- `{{user.name}}`, `{{user.pronoun}}`, `{{user.short_desc}}`
- `{{ai.name}}`, `{{ai.pronoun}}`, `{{ai.core_traits}}`, `{{ai.persona_note}}`
- `{{relationship.type}}`, `{{relationship.dynamics}}`
- `{{project.name}}`

Guidelines (from production experience):
- Describe what the companion *would do*, not what it *must not do* — positive framing works better than rule walls
- Keep it under 400 lines — long prompts dilute focus and eat thinking-token budget on some models
- Don't try to cover every edge case in the prompt — the memory retrieval handles context

See `core-prompt.example.txt` for a skeleton. `OSS_SETUP.md` has more detailed writing guidance.

### .env

Minimum required:

```
SANCTUARY_ENCRYPTION_KEY=<64-char hex: openssl rand -hex 32>
SESSION_SECRET=<64-char hex>
LOGIN_PASSWORD=<your password>
MIMO_API_KEY=<or OPENROUTER_API_KEY or GEMINI_API_KEY>
```

Full list in `.env.example`.

---

## Model recommendations

Each pipeline stage has different requirements. Here's what works in practice:

| Pipeline stage | Recommended model tier | Why | Examples |
|---------------|----------------------|-----|----------|
| Scribe (fragment extraction) | flash-lite / flash | Structured JSON output, cheap, runs frequently | DeepSeek V4 Flash, Gemini 2.5 Flash, GPT-4o-mini |
| Archivist classify / rematch / graduate | flash | Batch processing with entity context, needs some reasoning | DeepSeek V4 Flash, Gemini 2.5 Flash |
| consolidateCategory (fragments → episodes) | flash / pro | 150-word narrative merging needs coherence | DeepSeek V4 Flash/Pro |
| clusterSagas (episodes → sagas) | flash / pro | 50-episode batch clustering, needs thematic abstraction | DeepSeek V4 Pro, Gemini 2.5 Pro |
| Agent garden decisions | flash-lite | Short prompt, frequent, binary choices | DeepSeek V4 Flash, Gemini 2.5 Flash |
| Entity overview generation | flash | Short summaries from known fragments | DeepSeek V4 Flash |
| Chat response | Your choice | Quality matters most here | Whatever you normally use |

All pipeline stages default to the same API config. You can split them across different models in the database `api_configs` table — a cheaper one for high-frequency tasks and a stronger one for consolidation/saga clustering.

## Cost

Memory pipeline only, excluding your chat model. Estimates based on an active user (several chat sessions per day):

| Operation | Calls/day | Cost/day |
|-----------|-----------|----------|
| Fragment extraction | ~8 | ~$0.08 |
| Deep cycle (classify + consolidate + saga) | ~15 | ~$0.10 |
| Agent tick decisions + maintenance | ~40 | ~$0.04 |

**Total: ~$0.22/day, ~$7/month** at June 2026 flash-lite pricing (~$0.14/M input, ~$0.28/M output on OpenRouter). Actual cost depends on chat volume and model choice. See `docs/COST.md` for a detailed breakdown.

---

## Documentation

| File | What |
|------|------|
| `OSS_SETUP.md` | Step-by-step deployment guide + AI agent setup script |
| `TECH_DOCS.md` | System overview, database schema, API reference |
| `MEMORY_ARCH.md` | Full memory architecture design, cognitive model, lifecycle engine |
| `docs/COST.md` | Per-model pricing and cost breakdown |

---

## Testing

```bash
node tests/smoke.js         # End-to-end system check
node tests/smoke_memory.js  # Memory pipeline only
```

---

## License

MIT — see [LICENSE](LICENSE).
