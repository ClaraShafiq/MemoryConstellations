# 测试与验收

所有记忆回归都应使用新的临时 SQLite 文件和完全虚构的 fixture。测试库已存在时换路径；不要指向个人或生产数据库。

## 现代主链

```bash
DB_PATH=/tmp/memory-modern.sqlite \
SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm run test:memory-modern
```

覆盖空库 v118、Scribe 逐字引文和主体、Claim/Duty/Classification/Node Review、证据池、星座身份/别名/准入、Episode、Saga、Facts/Status、Judgment 证据门、Codex Judgment 禁令、搜索投影、CAS 和租约。

## 车道、失败停点与旧旁路

```bash
DB_PATH=/tmp/memory-lanes.sqlite \
SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm run test:memory-lanes
```

覆盖实时/回补租约隔离、Review 后 Duty/Classify 继承车道、拒绝项在 Duty/Classification 前零模型结束、Scribe 失败不推进游标、60→30→15 缩批与冷却，以及 modern 模式下旧写入旁路 fail-closed。

## 扩展安全合同

```bash
DB_PATH=/tmp/memory-extensions.sqlite \
SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm run test:memory-extensions
```

覆盖：

- 精确消息重放不推进主游标，assistant 自我陈述不能误归 user；
- 被拒 Claim Recovery 只读原消息并 supersede 旧 Claim；
- 不变证据进入 deferred，分类变化后重开；
- 星座发现类型门槛和核心身份隔离；
- 纠错先入收件箱，不直接改 Profile；
- Facts 差量 revise 保留未触及事实；
- Judgment `add/reinforce/revise/withdraw` 与态度证据；
- Agent 收到解密后的最小只读快照而非 SQL 能力；
- 向量 receipt、远端 metadata 核验、release prepare/activate、投影变化自动降级和 rollback；
- 每日模型预算、单飞和过期租约恢复。

## 其他定向测试

```bash
npm run test:llm-config
npm run test:contracts
npm run test:ssrf
```

- `test:llm-config` 使用虚构 endpoint 和临时库，验证代理、`NO_PROXY`、API key 加密与空配置；不发模型请求。
- `test:contracts` 验证时区入口和前后端路由合同。
- `test:ssrf` 验证现有 URL/IP 安全规则。

## 文档与隐私

```bash
npm run check:docs
npm run check:privacy
```

文档检查验证相对 Markdown 链接。自动隐私检查只扫描相对 HEAD 的新增文本与新增文件，可发现私人绝对路径、数据库产物、常见 secret、邮箱和非示例域名；它不能替代人工审阅。提交前仍要人工检查 fixture 是否为全新虚构事件，以及文档是否泄露部署状态、规模或 persona。

## 运行时核验

`GET /api/health` 应分别报告：

- schema version；
- effective 与 requested chat read mode；
- semantic maintenance 状态；
- maintenance runner 是否 active；
- Claim、证据池、Episode、Profile、搜索单元计数；
- verified release 和向量 manifest blocker。

`npm run memory:release:status` 用于更详细地检查 receipt 数、manifest digest 和有效读模式。

## 最终真实验收

自动回归不等于部署验收。具体部署至少要完成：

1. 新自然消息进入 Scribe，主体与逐字引文正确。
2. 受控审查、证据池、星座、Episode 和 Profile 字段真实发布。
3. Judgment 只有在 assistant 态度证据充分时由 persona writer 生成；失败保旧。
4. SQL/向量 manifest 追平，`release:prepare` 通过。
5. 激活后实际聊天模型召回正确内容。
6. 修改投影可自动回落 legacy，并成功演练显式 rollback。

在第 5 步完成前，不能写“现代管线已全面上线”。
