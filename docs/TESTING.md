# 测试与验收

## 聚焦回归

```bash
DB_PATH=/tmp/memory-constellations-modern.sqlite \
SANCTUARY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm run test:memory-modern
```

测试使用虚构人物 River，覆盖：空库 v110、Scribe 精确引文、Claim 审查、证据池 grounded、实体关联、Episode 发布、Facts/Status 独立发布、Judgment 证据门、Codex Judgment 禁令、检索投影、CAS 和租约。

## 文档与隐私

```bash
npm run check:docs
npm run check:privacy
```

文档检查验证相对 Markdown 链接存在。隐私检查只扫描本次相对 HEAD 新增或修改的文本文件，阻止私人绝对路径、数据库文件、常见密钥格式、邮箱和非示例私有域名。

## 最终真实验收

自动测试不能替代以下部署验收：

1. 一条全新自然消息被 Scribe 读取。
2. 原子观察与 Claim 有正确精确引文。
3. 审查、星座准入与 Episode/Profile 发布完成。
4. verified 检索生成正确聊天包。
5. 实际伴侣人格模型在新一轮聊天中召回正确内容。

当前仓库不宣称这一步已在参考部署完成。
