# 受控记忆管线架构

## 核心不变量

1. 原始消息是证据，不是自动成立的事实。
2. Scribe 只提取原子观察和精确引文，不负责实体准入或人格判断。
3. 不能归属的 Claim 留在证据池；相关输入指纹不变时不重复开放。
4. 模型只提出类型化 action，宿主验证后写库。
5. Facts、Status、Judgment 独立发布、独立版本、独立回滚。
6. 非空 Judgment 只能来自已绑定 persona 的伴侣人格写作者。
7. 读侧只消费正式发布投影；legacy 与 verified 可回滚切换。
8. 实时任务与历史回补使用不同车道；正式在线 runner 只消费实时车道。
9. 现代协议启用后，旧分类、Skills、Insight、Flash 和认知融合入口必须 fail-closed。

## 写入链路

`memoryScribe.js` 用复合游标读取消息，把精确引文冻结到 observation 和 `memory_claim_sources`。消息内容、说话人、时间或状态变化会改变 source fingerprint。

Scribe 的模型可替换，但输出合同不可替换。失败时不推进复合游标：同一游标连续失败会把批量从 60 收窄到 30、再到 15；15 条仍失败后自动冷却一小时，显式人工重试可绕过冷却。成功推进到新游标后恢复正常批量。

Claim 随后经过三类独立判断：

- `memoryClaimReview.js`：证据是否支持、归属是否支持、时间状态。
- `memoryClaimDuty.js`：stable fact、current state、event、preference、opinion 等职责。
- `memoryClassification.js` / `memoryNodeReview.js`：是否关联星座，以及关联扮演的角色。

Claim Review 创建下游任务时，Duty 与 Classify 都继承上游 priority。已拒、失效、来源变化或尚未支持的 Claim 会以 `classification_no_supported_claims` 零模型结束；公共实现直接以 Claim 为分类材料，不读取派生 Fragment 正文作后备。

## 实时与回补车道

- priority 100 及以上：新自然消息产生的实时任务。
- priority 100 以下：导入、存量修复和显式历史回补。
- `memoryPipeline.tick()` 与运行期受控 Agent 默认只租用实时车道。
- 只有显式传入 `priorityBand=backfill` 的维护操作才能消费历史车道。
- 从 Claim Review 到 Duty、Classify、证据池、Episode、Profile、Judgment 和检索投影，任务始终继承来源车道。

`memoryEvidenceResolution.js` 汇总这些结论，并记录明确的阻断原因。`needs_resolution` 在证据指纹不变时进入 `deferred`；只有新输入才重开。

## 星座

身份解析和星座准入分离：

- `memoryConstellationIdentity.js` 处理候选身份和有逐字证据的别名。
- `memoryConstellation.js` 决定 admitted、contained 或 rejected，并维护有 Claim 证据的关系。

普通细节不能单独创建正式星座。identity resolved 也不等于 admitted。

## Episode 与 Saga

`memoryEpisodeCandidates.js` 只接受 grounded 或 unassigned 的已验证 Claim。没有稳定实体或仍在进行的内容进入 transient 候选。`episodeWriter.js` 通过 input hash 和 Claim 清单校验后发布到现有 `memories` 表，并保留发布历史。

`memorySagaProjection.js` 只引用已经发布的 Episode。Saga 是叙事组织层，不替代证据或星座。

## Profile 三字段

`memoryProfileProjection.js` 为实体组装当前合格 Claim 快照。`memoryProfileFields.js` 分别发布：

- Facts：客观、可核对；允许结构化审查者。
- Status：有时效的近期状态；允许结构化审查者。
- Judgment：第一人称主观看法；非空值要求 `producer=persona_writer`、`model_role=companion_persona` 和 persona hash。

证据不足可由 judgment gate 发布空值。调用失败或解析失败不调用 publish，因此旧值不被覆盖。

## 受控 Agent

`memoryCodexReviewPolicy.js` 是 action allowlist。`memoryCodexBackend.js` 只负责把 job 交给只读提案者；`memoryCodexExecutor.js` 校验 action 并调用具体宿主函数。它不接受 SQL、shell 或自由写库命令，并显式阻止 Codex 生成非空 Judgment。

Codex 只是当前已实现的一个适配器。任何能调用工具并稳定输出本项目类型化 action 的 Agent 都可按接口接入；它不能因此获得 SQL 或绕过宿主校验。Scribe、客观维护者、人格写作者和聊天主模型是四种职责，不要求由同一供应商提供。

租约保证只有当前持有者能完成 job；CAS 保证 action 针对的 revision 与 input hash 仍然有效。

## 检索

`memorySearchProjection.js` 只投影合格 Claim、已发布 Episode 和已发布 Profile 字段。`memoryChatPacket.js` 生成有长度上限、带 revision/input hash 的聊天注入包。`routes/recall.js` 根据 `memory_chat_read_mode` 在 legacy 和 verified 读侧间选择。

## 当前边界

现代控制面已有聚焦测试，但默认未切换生产消费者。`maintenance=running` 表示写入/审核链在跑；`chat_read_mode=verified` 才表示聊天消费者已切换。参考部署目前是 running / legacy，仍在等待真实自然消息贯穿并被角色模型召回。宏观认知/直觉、最终检索路由和完整消费者切换属于后续阶段。
