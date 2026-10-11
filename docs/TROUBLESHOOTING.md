# 故障排查

## 启动时报加密密钥错误

确认 `SANCTUARY_ENCRYPTION_KEY` 是恰好 64 个十六进制字符，并且启动进程加载了正确 `.env`。不要为绕过错误而更换已有库的密钥。

## 空库迁移失败

用新的 `/tmp/*.sqlite` 重跑聚焦测试。如果失败，保留完整错误和失败版本；不要手工在生产库补列后假装迁移成功。

## Scribe 没有新增 Claim

检查 `pipeline.mode`、`MEMORY_SCRIBE_MIN_MESSAGES`、消息 `status='sent'`、游标和模型 JSON。现代 Scribe 要求引文是原消息的精确子串；不匹配会拒绝整批并保留旧游标。

## 证据池一直 needs_resolution/deferred

查看 `reason_code`。同一 evidence fingerprint 不会无休止重试；需要增加或纠正输入、分类、节点审查，不能只重启任务。

## Judgment 没有生成

这是安全默认。检查证据是否充分、persona writer 是否启用并绑定 persona hash。结构化 Agent 或 Codex 的非空 Judgment 会被拒绝。生成失败时旧值应保留。

## verified 召回为空

确认 Profile/Episode 已发布并已刷新 `memory_search_projection`，以及数据库 `memory_chat_read_mode` 已在完成验收后显式设为 `verified`。切回 `legacy` 可恢复旧读侧。

## Codex 维护任务失败

确认主机已安装并登录 Codex CLI，且适配器以 read-only sandbox 运行。查看 job 的 `error_code`。不要把解决方式改成授予 SQL 或 shell 写库权限。
