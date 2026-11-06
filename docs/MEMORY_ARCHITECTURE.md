# 受控记忆管线架构

## 核心不变量

1. 原始消息是证据，不是自动成立的事实。
2. Scribe 只提取原子观察、主体和逐字引文，不提前完成星座准入、人格判断或关系推断。
3. 模型只能提交闭集 action；宿主是正式表的唯一写入者。
4. 来源指纹、revision、租约和 CAS 任一不匹配都必须 fail-closed。
5. Facts、Status、Judgment 独立发布、独立历史、独立回滚。
6. 非空 Judgment 只能由绑定 persona 的写作者生成，且必须有 assistant 态度证据或审核 seed。
7. 实时任务与历史回补分车道；在线 runner 只消费实时车道。
8. maintenance running 与 verified read mode 是两个独立状态。
9. modern 模式启用后，旧 Scribe、Archivist、Skills、Insight、Flash 和认知融合写入口必须停用。

## 从消息到 Claim

`memoryScribe.js` 使用 `(picked_up_at/timestamp, message_id)` 复合游标读取消息。每条观察保存：

- 中性原子正文；
- `user / assistant / third_party / unknown` 主体；
- domain 与时间状态；
- 消息 ID、逐字引文、speaker、来源时间和消息指纹。

assistant 自我陈述不能被标成 user 事实。主体若不是来源 speaker，必须由引文中的显式角色名支持。`replayMessages()` 可对最多 20 条明确消息精确重放，且不推进主游标。

提取失败不会写 Fragment、Claim 或成功游标。同一游标连续稳定失败时，批量依次从 60 缩到 30、15；15 仍失败后冷却一小时。成功推进后恢复正常批量。

`WORLD_CONTEXT` 不再是硬编码私人 persona。`worldContext.js` 提供可替换 provider；公共默认只描述 user/assistant 的通用边界。

## Claim 审查、恢复与证据池

一个 Claim 必须依次满足：

- `memoryClaimReview.js`：来源支持、主体归属、时间状态；
- `memoryClaimDuty.js`：stable fact、current state、event、preference、opinion 等职责；
- `memoryClassification.js`：关联实体、topic only、无独立节点或需要继续裁决；
- `memoryNodeReview.js`：对每个候选实体/role 做逐项证据审查。

Claim Review 之后的 Duty 与 Classification 继承原 job priority。已拒、来源变化或未支持的 Claim 在 Duty/Classification 前置检查中零模型结束。

被拒 Claim 会为其来源 Fragment 创建 `claim_recovery` job。`memoryClaimRecovery.js` 只读取绑定的原始消息和逐字引文；它禁止用 Fragment 派生正文作分类后备。恢复成功会创建新的原子 Claim，并以 CAS 方式把旧的非人工锁定 Claim 标为 superseded。

`memoryEvidenceResolution.js` 保存状态与明确 reason code：`ineligible / needs_resolution / deferred / unassigned / topic_only / node_candidate / grounded`。相同证据指纹的重复 `needs_resolution` 会转为 `deferred`；时间流逝本身不触发重开。来源或上游结论变化后，新的指纹才允许重新裁决。

## 结构化纠错

`POST /api/memory/corrections` 只接收消息 ID、逐字引文、纠正文和可选目标 Claim。`memoryCorrection.js` 将其保存为收件箱 receipt 并排入实时审查车道。

对话角色不能直接改成品 Profile。审查通过后，宿主创建 domain=`correction` 的新 Claim，并以 CAS 让旧 Claim 失效。Facts/Status 的 `revise` 或 `withdraw` 必须引用 correction Claim；未被操作的字段项原样保留。

## 星座

星座分为发现、身份、准入三个阶段：

1. `memoryConstellationDiscovery.js` 只接受可用证据池 Claim，并要求候选名称出现在 Claim 或引文中。
2. `memoryConstellationIdentity.js` 解析身份和逐字有据的别名；核心 user/assistant 身份不能作为普通第三方 Profile 创建。
3. `memoryConstellation.js` 决定 admitted、contained 或 rejected；普通细节不能以 admitted 方式独立成星。

身份 resolved 不等于准入完成。`same_as / part_of / related` 的正式关系发布仍是 Roadmap；保留旧表不代表已经有权威关系 writer。

## Episode 与 Saga

`memoryEpisodeCandidates.js` 只接受 grounded 或 unassigned 的合格 Claim。没有实体或仍在进行中的内容标为 transient；其他候选进入 `episode_publish` 受控审查。

`episodeWriter.js` 校验 candidate input hash 和完整 Claim 清单后，发布版本化 Episode 并保留历史。`memorySagaProjection.js` 只能引用已发布 Episode；Saga 是叙事组织层，不替代 Claim 证据或星座身份。

## Profile 三字段

`memoryProfileProjection.js` 只组装当前仍 eligible 且 grounded 到目标实体的 Claim。核心 user/assistant 身份走独立配置，不落普通第三方 Profile。

- Facts：基于现有可信 items 与新增/纠正 Claim 执行 `add/revise/withdraw`；不会因一次生成遗漏而删除未触及事实。
- Status：同样差量更新，但只允许 current state/event，并拒绝历史、取消或过旧 completed 证据。
- Judgment：最多三个稳定态度 facet，支持 `add/reinforce/revise/withdraw`。普通事实再多也不能创建态度。

每个字段有独立 revision、input hash、producer、model role、persona hash、Claim 清单和 history。空 Judgment 可由 evidence gate 发布为 tombstone；非空值要求 `producer=persona_writer`、`model_role=companion_persona` 和合法 persona hash。客观 Agent 的任何 Judgment action 都在 policy 层被拒绝。

## 受控维护 Agent

`memoryCodexExecutor.js` 为每个 job 生成最小只读证据快照，再调用适配器的 `propose({ job, input })`。适配器只能返回 `memoryCodexReviewPolicy.js` allowlist 中的 action；不能提交 SQL、shell 或命令。

宿主随后再次检查：

- action 类型与 job stage/target 是否一致；
- expected revision 与 input hash；
- 来源指纹和逐字引文；
- producer/model role；
- 当前租约 token；
- 每日模型调用预算。

`memoryCodexBackend.js` 提供当前已实现的 Codex CLI 只读适配器。其他 Agent 可实现相同 `propose` 接口。Codex 也可作为部署和管线工程助手，但部署权限不等于运行期正式写权限。

## 调度、车道与自愈

- priority 100 及以上：实时消息与实时纠错。
- priority 100 以下：导入、存量修复和显式 backfill。
- `memoryMaintenanceRunner.js` 单飞执行 Scribe、当前车道受控审查、确定性推进和向量同步。
- 没有配置审查 backend 时，runner 保留 model job 并在结果/健康状态中暴露 backlog，不伪造完成。
- 过期租约进入 retry；连续尝试达到上限后进入 needs_review，不无限自旋。
- `memoryModelBudget.js` 以 UTC 日和角色计数。默认 limit=0，模型调用禁用；预算耗尽 fail-closed。

历史回补必须显式使用 `priorityBand=backfill` 的维护操作，在线 runner 不会自然消费它。

## SQL、向量与 verified 门禁

`memorySearchProjection.js` 只投影可读 Claim、已发布 Episode/Saga 和非空 Profile 字段。每个 projection key 带 revision 与 source hash。

`memoryVectorProjection.js` 为每次 upsert/delete 保存租约、尝试次数和 acknowledged receipt。Chroma 使用独立 collection `memory_constellations_verified`；远端对象的 `projection_key / revision / source_hash` 必须与 SQL manifest 一致。查询结果也会再次按本地 receipt 过滤。

`memoryReleaseGate.js` 的流程是：

1. `prepare`：SQL manifest 完整、所有 receipt 完成、远端 metadata 逐项一致；
2. `activate`：manifest digest 未变化时才把 requested mode 设为 verified；
3. 消费：`memoryReadMode.get()` 每次确认 release 仍 ready，否则有效模式回退 legacy；
4. `rollback`：显式恢复 legacy，不删除现代发布历史。

`memoryChatPacket.js` 最终生成有长度上限并带 revision/input hash 的注入包。maintenance running 只描述写入链；只有有效 read mode 为 verified 才表示聊天消费者正在读取现代发布物。

## 当前边界

公共控制面与虚构数据回归已实现，但默认安装没有自动生产切换。仍未完成：正式关系发布、Status 重要经历沉降的完整验收、Macro Insight 真实聊天路由、每周/月度复核、assistant 长期演化 PT，以及任何具体部署的旧数据全量回补和自然聊天最终验收。
