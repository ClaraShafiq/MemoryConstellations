# 故障排查

## 启动时报加密密钥错误

确认 `SANCTUARY_ENCRYPTION_KEY` 恰好是 64 个十六进制字符，且启动进程加载了正确 `.env`。不要为绕过错误而更换已有库的密钥；那会让旧密文不可读。

## 空库迁移失败

换一个新的 `/tmp/*.sqlite` 路径运行 `npm run test:memory-extensions`。记录完整失败版本和错误。不要手工在正式库补列后宣称迁移成功。

## Scribe 不工作

依次检查：

- `memory_config.json` 是否为 `pipeline.mode=modern`；
- `npm run memory:maintenance:status` 是否为 running；
- `MEMORY_SCRIBE_DAILY_CALL_LIMIT` 是否大于 0；
- 消息是否为 `status=sent`、非 image，且位于复合游标之后；
- 模型是否返回闭集 JSON，quote 是否为原消息精确子串。

失败批次不会推进游标。连续稳定失败会缩为 30、15 并冷却一小时；先修输入或模型合同，不要通过手改游标跳过消息。

## Claim 停在 review/duty/classification

查看 `/api/health` 的 backlog 和 job `error_code`。若 runner 报 `reviewer_required`，说明只启动了确定性调度，没有配置 `maintenanceBackend` 或启用 Codex 适配器。若错误为 `memory_model_calls_disabled/exhausted`，设置或提高明确的每日上限；不要绕过预算表。

被拒、失效或来源变化的 Claim 本来就不会调用 Duty/Classification 模型。被拒项应进入 `claim_recovery`，并且只能从原消息恢复。

## 证据池长期 needs_resolution/deferred

查看 `reason_code`。相同 evidence fingerprint 不会因重启或等待而重新开放；必须增加/纠正来源、Duty、Classification 或 Node Review。`deferred` 是防止重复消耗的正常状态。

## 星座没有创建

检查 Claim 是否已 grounded/unassigned/topic_only、候选名称是否真的出现在 Claim/引文中，以及类别和导航价值 basis 是否在闭集内。核心 user/assistant 身份不会作为普通第三方星座创建。identity resolved 仍需 admission；普通细节不能单独 admitted。

## 纠错没有直接改变 Profile

这是设计行为。纠错 API 只创建 receipt 和审查 job。必须先生成 correction Claim、让旧 Claim superseded，再由 Facts/Status 的 `revise/withdraw` 差量发布。对话角色没有成品 Profile 直写权限。

## Judgment 没有生成

这是安全默认。普通事实数量不能建立第一人称态度。非空 Judgment 需要 assistant 原始 `companion_opinion` Claim 或审核 seed、persona writer、`companion_persona` role 和 persona hash。结构化 Agent/Codex 的 Judgment action 会被拒绝。调用或解析失败不应触发 publish，因此旧值必须保留。

## verified prepare 失败

运行：

```bash
DB_PATH=./memory_constellations.db npm run memory:release:status
```

常见 blocker：

- `projection_receipt_count_mismatch`：SQL 投影与 receipt 数不一致；
- `projection_receipts_incomplete`：仍有 queued/retry/running 或未 acknowledged 项；
- `projection_stale:*`：revision/source hash 已变化；
- `remote_missing:*` / `remote_stale:*`：Chroma collection 中缺项或 metadata 不一致。

确认 `CHROMA_URL`、向量服务、独立 collection 和 maintenance runner 正常，再重新 prepare。不要直接把数据库开关改为 verified。

## requested 是 verified，但 effective 仍是 legacy

release manifest 在激活后发生了变化，或 receipt 不再完整。有效读模式自动回退是预期保护。先修投影并重新 `prepare`；需要立即回滚时运行 `npm run memory:release:rollback`。

## Codex 运行期适配器失败

确认 `ALLOW_MEMORY_CODEX_CLI=1`、`MEMORY_CODEX_ISOLATED_CWD` 存在，且 Codex 已按 [OpenAI 官方文档](https://developers.openai.com/api/docs/guides/code-generation) 配置。适配器必须保持 read-only，只根据宿主提供的 `job + input` 快照返回一个 JSON action。不要通过授予数据库或 shell 写权限来“修复”。
