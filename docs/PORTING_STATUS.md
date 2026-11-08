# 公共能力同步状态

本表只记录可复用协议、公共实现和不含私密细节的验收边界，不记录任何参考部署的消息、数据库、角色 prompt、模型请求、成本或规模。

| 能力 | 分类 | 公共落点 | 说明 |
|---|---|---|---|
| Scribe 完整语义观察、来源绑定、复合游标 | 直接移植并泛化 | `memoryScribe.js`、`memoryConversationSubjects.js` | 同批次先整体理解；主体改为 user/assistant/third_party/unknown；支持精确消息重放 |
| Scribe 完整性审计 | 按公共闭集适配 | `memoryScribe.js` | 同批次过度拆分会重试；拒绝缺对象/含糊对象；同消息多段证据收拢为连续逐字引文 |
| 失败不越过、60→30→15、自适应冷却 | 直接移植 | `memoryScribe.js` | 三次稳定失败后一小时冷却 |
| Claim Review、Duty、Classification、Node Review | 直接移植并接线 | `memoryProtocol.js` 及对应 service | 下游继承来源车道；不支持 Claim 零模型结束 |
| 被拒 Claim Recovery | 新增公共实现 | `memoryClaimRecovery.js` | 只读绑定消息，不读 Fragment 派生正文；旧 Claim 以 CAS supersede |
| 待裁决证据池 | 直接移植并扩展 | `memoryEvidenceResolution.js` | 不变指纹进入 deferred；变化后才重开 |
| 星座发现、身份、别名、准入 | 适配现有实体表 | `memoryConstellationDiscovery.js`、`memoryConstellationIdentity.js`、`memoryConstellation.js` | 核心身份隔离；别名要求逐字证据 |
| Episode Candidate / Episode / Saga | 适配现有 `memories` 与 `memory_sagas` | `memoryEpisodeCandidates.js`、`episodeWriter.js`、`memorySagaProjection.js` | Candidate 自动进入受控发布 job；Saga 进入检索投影 |
| Facts / Status 差量发布 | 新增 v2 字段格式 | `memoryProfileFields.js` | `add/revise/withdraw`；纠正/撤回要求 correction Claim |
| Judgment facet 差量发布 | 新增 v2 字段格式 | `memoryProfileFields.js` | `add/reinforce/revise/withdraw`；只接受 assistant 态度或审核 seed |
| 结构化纠错收件箱 | 新增公共接口 | `memoryCorrection.js`、`routes/memory-corrections.js` | 对话侧只能提交证据，不能直改成品 Profile |
| 受控维护 Agent | 适配公共 job | `memoryCodexReviewPolicy.js`、`memoryCodexExecutor.js`、`memoryCodexBackend.js` | Agent 接收只读最小快照；Codex 已有适配器，其他 Agent 可按接口接入 |
| 实时/回补车道、单飞、租约自愈 | 直接移植并泛化 | `memoryMaintenanceRunner.js`、`memoryProtocol.js` | 在线 runner current-only；过期租约有限重试 |
| 调用预算 | 新增公共实现 | `memoryModelBudget.js` | 默认 0，按角色和 UTC 日 fail-closed |
| SQL/向量投影与来源指纹 | 新增公共实现 | `memorySearchProjection.js`、`memoryVectorProjection.js` | 独立 collection、receipt、revision/source hash 远端核验 |
| verified 发布与回滚 | 新增公共实现并已有参考切换验收 | `memoryReleaseGate.js`、`memoryReadMode.js`、`scripts/memory_release.js` | manifest 变化后 fail-closed；只允许显式 rollback 到 legacy；其他部署仍须独立验收 |
| 派生状态健康与确定性修复 | 新增公共实现 | `memoryDerivedStateHealth.js`、`memoryProjectionReconciler.js`、`scripts/memory_health.js` | 三态健康；本地 blocker 不受读模式隐藏；权威发布物重建；远端缺失/陈旧/待删/多余向量核验 |
| 旧兼容纠错反馈 | 修复公共旧链 | `correction.js`、`lifecycle.js` | 保存来源消息快照；同源降权幂等；普通纠错拒绝空正确内容；不反向移植到现代 Claim 纠错协议 |
| legacy FTS 一致性 | 适配旧公共实现 | `memoryLegacyFts.js`、`scripts/rebuild_fts.js` | 只索引 active Fragment；仅在 legacy 模式纳入权威健康检查 |
| 可插拔角色上下文 | 泛化适配 | `worldContext.js` | 公共默认无私人 persona；部署方可注入 provider |
| 旧语义旁路 fail-closed | 按公共仓库实际模块适配 | `archivist.js`、`skillManager.js`、`cognitiveModel.js`、`tasks/cron.js` | modern 模式不启动旧 writer；未制造不存在模块的假实现 |

## 只属于具体部署，未同步

- 生产数据库、备份、WAL/SHM、历史回补库和数据快照；
- 原始聊天、Fragment/Claim 正文、Profile、Judgment、日记、日志和模型请求/响应；
- 私人 persona、角色世界观、真实身份映射、密钥、账号、登录目录和内部域名；
- 私有数据规模、进程信息、调用成本回执和运营脚本；
- 具体部署的旧数据全量回补决定。

## 尚未完成

- `same_as / part_of / related` 正式关系发布；
- Status 替换前的重要经历沉降完整验收；
- Macro Insight 的真实聊天意图路由；
- 每个新部署的真实数据发布、召回验收和 verified 切换；
- 每周健康扫描的自动调度、每月 Profile 全景复核和 assistant 长期演化 PT；
- 参考部署之外的“新自然消息 → 正式写入 → verified 检索 → 聊天模型实际召回”最终验收。

维护者参考部署已分别核验正式维护链 running 与有效 verified read mode，但公共仓库不替其他部署宣称已经 running 或已经切读。两种状态必须在每个部署中分别核验。
