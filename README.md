# Memory Constellations · 记忆星图

A self-organizing memory system for AI companions. Extracts facts from chat, groups them by topic, and merges them into coherent narratives — all on autopilot.

Built by **Open Source Community**.

---

## What it does

Three things happen automatically while your companion runs:

1. **Extract.** Scribe scans new chat messages and pulls out facts — who, where, what happened, what changed. Each fact is a short, third-person sentence with a link back to the original messages.

2. **Organize.** Archivist runs every 2 minutes. It groups related facts into topics (constellations), merges tightly-related facts into narrative paragraphs (episodes), and periodically links related episodes into long-term story arcs (sagas — experimental, not yet running in production).

3. **Retrieve.** When your companion needs context during a chat, Librarian searches across all three layers — raw facts, narrative episodes, and entity profiles — using a mix of keyword matching, vector similarity, and entity aggregation.

(Optional) A 5-axis emotional state engine ([jiwen](https://github.com/ClaraShafiq/jiwen), a separate project) provides continuous emotional drift for companions that want affect modeling beyond memory alone.

---

## What you see

Open `/memory.html` — it renders a star map from the database:

- Five galaxies (Social, Places, Events, Hobbies, Projects) orbit a binary core (you + your companion)
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
    │   ├─ Maintain behavior patterns (bigram match, freshness refresh)
    │   ├─ Expire time-based entries (TTL-based current_state expiry)
    │   └─ Detect and merge duplicate entities
    │
    └─ Deep cycle (user idle ≥1 hour, LLM-heavy)
        ├─ Classify unlinked fragments → assign to entities
        ├─ Grow seeds (new entities) → graduate to active
        ├─ Consolidate fragments per entity → episodes (narrative memories)
        ├─ Cluster episodes across entities → sagas (experimental)
        ├─ Discover emergent people/places/events
        ├─ Regenerate entity overviews (facts + judgment + current status)
        ├─ Detect new cognitive traits → refine companion's understanding
        └─ Cross-reference current states with entity profiles
    │
    ▼
Librarian ── called at chat-time
    │       ── Hybrid search: FTS5 + vector + entity aggregation
    │       ── RRF fusion, episodes weighted 1.5× over raw fragments
    │       ── Results tagged with recall permission level
    │
    ▼
System Prompt ── injected: relevant memories + entity profiles + user profile + companion profile
    │
    ▼
jiwen (optional) ── separate project: github.com/ClaraShafiq/jiwen
                ── 5-axis continuous emotional state engine
                ── Not required for memory pipeline — both systems work independently
```

---

## Memory layers

### Core memory layers

| Layer | Storage | Contents | Update trigger |
|-------|---------|----------|---------------|
| Fragments | `memory_fragments` | Single facts, ≤80 chars, third-person, typed (observation/reflection/preference/event/state) | Scribe, per chat session |
| Entities | `entity_profiles` | Named people/places/events/hobbies/projects, with three-field model (facts + current_status + judgment) | Archivist classify + graduate + overview regeneration |
| Episodes | `memories` (layer=episode) | Merged fragment narratives, 100-250 chars, with date correction and contradiction detection | Deep cycle consolidate |
| Sagas | `memory_sagas` | Cross-entity narrative arcs (experimental — clustering runs but not yet consumed in production) | Every 24h or on new episodes |

### User model layers — what the companion knows about you

The system maintains three layers of user understanding at different time scales. Each layer serves a distinct purpose and updates independently:

| Layer | Storage | Timescale | Contents | Update mechanism |
|-------|---------|-----------|----------|-----------------|
| **current_state** (瞬态) | `user_model` type=current_state | Hours to days, TTL-expiring | Transient states the companion tracks: "she's on her period", "she just moved", "she's stressed about a deadline" | Companion writes via chat tools; auto-resolves on TTL expiry |
| **current_status** (近期动态) | `entity_profiles.current_status` | Days to weeks | Recent developments per entity: "moved to a new apartment in July", "started a new project at work" | Archivist regenerates on significant change; companion can update mid-chat |
| **behavior patterns** (行为模式) | `user_patterns` | Weeks to years, confidence-only-grows | Long-term behavioral regularities: "prefers golden-haired characters with sharp wit and hidden vulnerability", "has strong aesthetic opinions about living spaces" | Auto-clustered from observation & preference fragments; bigram-matched every 6h; new patterns discovered every 24h deep cycle |

**Key design principle:** Behavior pattern confidence only increases — a person doesn't "stop preferring golden-haired characters" just because they haven't mentioned it in three months. Freshness controls injection priority independently from confidence.

### Entity three-field model

Each entity (person, place, event, hobby, project) has three fields, all generated in a single LLM call during overview regeneration:

| Field | What it is | Update rule |
|-------|-----------|-------------|
| **facts** | Objective facts about the entity — stable, verifiable information | Unconditional overwrite — new facts replace old |
| **current_status** | Latest known development — what recently changed | Covering update — new status replaces old; companion can update mid-chat |
| **judgment** | Companion's subjective impression — "what I feel about this person/place" | Evolutionary — old judgment shown as reference, can be revised or kept |

### Companion profile

The companion's own personality, self-understanding, and relationship context is stored in `persona_model` (five sections: identity, personality, relationship with user, self as AI, project context). This is injected into every system prompt and can be edited through a UI panel. In production, this replaces the static `core-prompt.txt` personality sections — but for open-source setup, `core-prompt.txt` remains the simplest starting point. See OSS_SETUP.md for both approaches.

---

## Retrieval design

Librarian uses RRF (Reciprocal Rank Fusion) to merge results from three independent channels: FTS5 keyword, vector similarity, and entity aggregation. Episodes get a 1.5× weight over raw fragments because a consolidated narrative carries more context than a single extracted fact.

Retrieved memories are tagged with a **recall permission level** computed deterministically (not by LLM):

| Permission | Condition | How the companion should use it |
|-----------|-----------|--------------------------------|
| **可引用** (cite) | Dual-channel hit + <30 days | Can directly reference as fact |
| **需谨慎** (cautious) | Single-channel hit or 30-90 days | Use "I seem to recall…" framing, leave room for correction |
| **仅联想** (associate-only) | >90 days or floated at random | Internal reference only — don't state as fact to the user |

A **segmented decay function** determines sort order: within 3 days, freshness dominates; after 3 days, emotional intensity dominates. Results below a combined score floor (0.005) are silently dropped — better silence than noise.

---

### Concurrency

Scribe and Archivist both write to `memory_fragments` and `entity_profiles`. SQLite's WAL mode ensures readers don't block writers. In practice the two are naturally staggered: Scribe only triggers after ≥20 minutes of silence, while Archivist runs on a 2-minute tick. No explicit lock is needed at current scale.

---

### Lifecycle (automatic cleanup)

| What | Active → Cooling | Cooling → Frozen | Frozen → Tombstone |
|------|-----------------|------------------|---------------------|
| Fragments | 14 days no access | 30 days, vector deleted | 90 days, content wiped |
| Episodes | permanent | 6 months → mature | 12 months → archived |

Access resets the timer — memories that get recalled stay fresh. Cooling fragments that are accessed auto-revive to active.

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

**Production note:** In Sanctuary's own deployment, the companion's personality sections have been migrated from `core-prompt.txt` into an editable `persona_model` database table, with a UI panel for live editing without restarting the server. The open-source version keeps `core-prompt.txt` as the simpler starting point — both paths are supported.

### .env

Minimum required:

```
SANCTUARY_ENCRYPTION_KEY=<64-char hex: openssl rand -hex 32>
SESSION_SECRET=<64-char hex>
LOGIN_PASSWORD=<your password>
LLM_API_KEY=<or OPENROUTER_API_KEY or GEMINI_API_KEY>
```

Full list in `.env.example`.

---

## Companion tools

These are the tools your companion uses to interact with their memory system. They're injected into the system prompt automatically — you just need to write their personality in `core-prompt.txt` and they'll know when to use each one. Tools can be toggled on/off individually via the companion's settings UI or the `user_settings` database table.

### `recall_memory` — Search memories

Two modes:
- **Keyword search** (`query`): Your companion searches their memory by keyword or phrase. Returns matching fragments and episodes.
- **Source trace** (`memory_id` + `offset`): Given a memory ID, trace back to the original conversation messages that produced it.

### `browse_memories` — Browse entity profiles

No parameters needed. Returns a top-level view of all memory partitions — people, places, events, projects. Your companion can see who they know about and how many memories are linked to each person.

### `manage_user_state` — Track user state

Three actions your companion uses to maintain a current picture of you:
- **set**: Record a new observation — "She started a new project, she's on her period, she just moved." Must include an expiry date (max 90 days). Optional `schedule` parameter for recurring reminders (e.g., medication: `{"type":"daily","windows":["08:00-10:00","19:00-21:00"]}`).
- **update**: Modify an existing observation (by state ID) — "That deadline changed" or "She's feeling better now."
- **resolve**: Mark something as ended — "She finished that project." Requires a brief reason. For scheduled reminders, resolve only acknowledges the current window — subsequent windows will continue to trigger.

States auto-expire. Your companion sees active ones in their intuition block and uses them to calibrate their tone.

### `correct_memory` — Handle corrections

When you tell your companion they remembered something wrong, they call this to record the correction. The system traces whether the error came from a specific memory fragment (fixes that fragment) or was something they made up (stores the correct version).

---

## Model recommendations

| Pipeline stage | Recommended model tier | Why | Examples |
|---------------|----------------------|-----|----------|
| Scribe (fragment extraction) | flash-lite / flash | Structured JSON output, cheap, runs frequently | DeepSeek V4 Flash, Gemini 2.5 Flash |
| Archivist classify / rematch / graduate | flash | Batch processing with entity context | DeepSeek V4 Flash |
| consolidateCategory (fragments → episodes) | flash / pro | 150-word narrative merging needs coherence | DeepSeek V4 Flash/Pro |
| clusterSagas (episodes → sagas) | flash / pro | 50-episode batch clustering, needs thematic abstraction | DeepSeek V4 Pro, Gemini 2.5 Pro |
| Agent garden decisions | flash-lite | Short prompt, frequent, binary choices | DeepSeek V4 Flash |
| Entity overview generation | flash | Short summaries from known fragments | DeepSeek V4 Flash |
| Chat response | Your choice | Quality matters most here | Whatever you normally use |

---

## Cost

Memory pipeline only, excluding your chat model. Estimates based on an active user (several chat sessions per day):

| Operation | Calls/day | Cost/day |
|-----------|-----------|----------|
| Fragment extraction | ~8 | ~$0.08 |
| Deep cycle (classify + consolidate + saga) | ~15 | ~$0.10 |
| Agent tick decisions + maintenance | ~40 | ~$0.04 |

**Total: ~$0.22/day, ~$7/month** at June 2026 flash-lite pricing. Actual cost depends on chat volume and model choice.

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
