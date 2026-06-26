# Cost Reference

## Memory pipeline only (excluding chat)

| Module | Calls/day | Model | Cost/day |
|--------|-----------|-------|----------|
| Agent Loop decisions | ~40 | flash-lite | ~$0.05 |
| Scribe extraction | ~8 | flash-lite | ~$0.05 |
| Deep cycle (classify/rematch/graduate) | ~15 | flash-lite | ~$0.03 |
| Snitch/news bots | ~5 | flash-lite | ~$0.01 |
| Music/book extraction | ~3 | flash-lite | ~$0.01 |
| Clara Model (read/validate/detect) | ~5 | flash-lite | ~$0.02 |
| Seed merge & emergence | ~3 | flash-lite | ~$0.01 |
| **Total** | **~80** | | **~$0.22/day** |

**~¥1.5/day, ~¥50/month**

## Model pricing (OpenRouter, June 2026)

| Model | Input / 1M tokens | Output / 1M tokens |
|-------|-------------------|-------------------|
| DeepSeek V4 Flash | $0.14 | $0.28 |
| Gemini 3.1 Flash Lite | $0.25 | $1.50 |
| DeepSeek V4 Pro | $0.44 | $0.87 |
| Gemini 3 Flash Preview | $0.50 | $3.00 |
| Gemini 3.1 Pro Preview | $2.00 | $12.00 |

## Chat costs (separate)

Chat responses use better models (Flash or Pro) and carry full context windows.
Budget ~$0.50-1.00/day for active conversation, depending on model choice and message volume.

## Optimization tips

- Set Scribe to flash-lite (default in this repo)
- Deep cycle tasks are already flash-lite by default
- Chat is the main cost driver — use Flash for casual conversation, Pro for deep talks
- All embedding runs locally (Jina + fastembed), zero API cost
