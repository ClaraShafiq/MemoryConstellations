# 能力同步状态

本表记录本轮从生产参考设计抽取到公共仓库的通用能力。它不包含生产数据、私人 prompt、真实模型请求或部署专属成本策略。

| 参考能力 | 公共实现 | 结果 |
|---|---|---|
| 原子观察合同与复合游标 | `memoryScribe.js`、v104–v107 | 已适配；显式 modern 模式启用 |
| Claim 来源、审查、职责和 job | `memoryProtocol.js`、`memoryClaimReview.js`、`memoryClaimDuty.js` | 已移植 |
| 分类、节点证据与阻断原因 | `memoryClassification.js`、`memoryNodeReview.js`、`memoryEvidenceResolution.js` | 已移植 |
| 星座身份、别名、准入和关系 | `memoryConstellationIdentity.js`、`memoryConstellation.js` | 已移植到现有 `entity_profiles` |
| Episode 候选与发布 | `memoryEpisodeCandidates.js`、`memoryEpisodeProjection.js`、`episodeWriter.js` | 已移植到现有 `memories` |
| Saga 发布 | `memorySagaProjection.js` | 已移植基础发布协议；没有宣称消费者已切换 |
| Facts / Status / Judgment 字段级发布 | `memoryProfileProjection.js`、`memoryProfileFields.js` | 已移植；独立版本和生产者边界 |
| 受控维护 Agent | `memoryCodexReviewPolicy.js`、`memoryCodexExecutor.js`、`memoryCodexBackend.js` | Codex CLI 只读提案适配器已实现；默认禁用；其他 Agent 按协议接入 |
| 检索投影与聊天包 | `memorySearchProjection.js`、`memoryChatPacket.js`、`routes/recall.js` | 已移植；默认仍读 legacy |
| 健康检查 | `routes/health.js` | 已移植；只返回模式和计数 |
| 生产 backfill 编排和成本治理 | 无 | 未移植；部署专属且可能包含生产状态 |
| 私人角色 prompt、真实案例、请求/响应、数据库和日志 | 无 | 明确禁止公开 |
| 宏观认知/直觉模块 | 无 | 阶段 6，尚未完成 |
| 最终检索路由与完整消费者切换 | 仅有可回滚开关 | 阶段 7，尚未完成 |
| 新自然消息到实际人格模型召回 | 无自动宣称 | 必须由具体部署完成最终验收 |
