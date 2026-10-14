# 测试与验收

## 聚焦回归

```bash
DB_PATH=/tmp/memory-constellations-modern.sqlite \
SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm run test:memory-modern
```

测试使用虚构人物 River，覆盖：空库 v112、Scribe 精确引文、Claim 审查、证据池 grounded、实体关联、Episode 发布、Facts/Status 独立发布、Judgment 证据门、Codex Judgment 禁令、检索投影、CAS 和租约。

## 车道与失败关闭

```bash
DB_PATH=/tmp/memory-constellations-lanes.sqlite \
SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm run test:memory-lanes
```

该测试覆盖：实时/回补租约隔离、Claim Review 后 Duty/Classify 继承车道、被拒 Claim 零模型结束、Scribe 失败不推进游标、60→30→15 缩批与冷却，以及现代模式下旧 Skills/Archivist 入口 fail-closed。

## 公共模型配置

```bash
npm run test:llm-config
```

该测试使用虚构 endpoint、模型名和临时空库，覆盖：未配置代理时直连、显式代理与 `NO_PROXY`、`MEMORY_LLM_*` 写入默认连接、API key 加密、空配置不播种虚假模型，以及 legacy Scribe 不再依赖维护者数据库 ID。不会发起模型请求。

## 文档与隐私

```bash
npm run check:docs
npm run check:privacy
```

文档检查验证相对 Markdown 链接存在。隐私检查只扫描本次相对 HEAD 新增或修改的文本文件，阻止私人绝对路径、数据库文件、常见密钥格式、邮箱和非示例私有域名。

## 运行期合同

```bash
npm run test:contracts
```

该测试验证 `TZ` 是服务端唯一时区入口、非法时区安全回退、浏览器与 Express 共用同一份 memory API 路由合同，并阻止前端重新手写这些 URL。

## 最终真实验收

自动测试不能替代以下部署验收：

1. 一条全新自然消息被 Scribe 读取。
2. 原子观察与 Claim 有正确精确引文。
3. 审查、星座准入与 Episode/Profile 发布完成。
4. verified 检索生成正确聊天包。
5. 实际伴侣人格模型在新一轮聊天中召回正确内容。

当前仓库不宣称这一步已在参考部署完成。参考部署的正式维护链虽已 running，聊天读侧仍为 legacy。
