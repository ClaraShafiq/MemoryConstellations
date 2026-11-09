# 记忆管线常见坑

这份清单记录容易造成“测试绿了但记忆仍然错误”的非显而易见边界。它只描述公共协议，不包含任何部署数据。

## 把 atomic 理解成按子句拆卡

atomic 指最小但完整、脱离聊天仍能理解的语义单元。同一对象、事件或未来检索用途的背景、动作、结果和解释应合并；只有不同对象或不同事件，且拆开后各自完整时才拆。

## 把问句当事实证据

问句可以让系统知道当前在谈哪个对象，但“它是不是蓝色？”不能证明它是蓝色。发布属性必须有后续陈述性逐字证据。

## Recovery 重做整个 Fragment

局部争议只能替换 `disputed_claim_ids`。重做整个 Fragment 会撤回已经通过的兄弟 Claim，也会让重复机器 Claim 越积越多。Recovery receipt 必须同时记录 preserved 与 disputed 闭集。

## 用后出现的同名对象解释前面的代词

代词只能使用描述之前已建立的锚。后文出现的同名对象不能倒流成为事实来源；无法唯一判断时保留 unresolved/needs_context。

## 把单次评价升级为长期偏好

“这次不错”“今天想吃”属于一次评价或事件。偏好需要喜欢、排斥、习惯或反复稳定选择等证据。对象材料的“可能由某材质制成”是另一类情况：可以保存为 qualified stable fact，但不得删掉“可能”。

## Classification 直接决定归属

Classification 只提出七类候选角色；Node Review 才决定 Claim 对星座的正式角色，Evidence Resolution 再投影最终状态。唯一命名物件的属性组也必须满足同 Fragment、唯一锚、来源完整三项条件。

## 让 event 混进 Facts

事件可以归属于对象，但 Duty 仍是 `event`，应进入 Episode/历史经历。Facts 只描述较稳定的“对象是什么”；Status 只描述近期会变化或结束的状态。

## 用一个总指纹绑住三个 Profile 字段

Facts、Status、Judgment 必须按各自证据集合计算 input hash。新增客观事实不应无故让旧 Judgment 失效；失效也不能让失败生成覆盖旧值。

## 只在写入时检查 verified

来源、Duty 或 Node 归属可能在发布后失效。SQL 与向量查询返回前必须重新校验当前状态；远端 receipt 存在不代表内容仍可读。

## 在 Web 进程里跑模型和向量批次

单飞只防重入，不防阻塞。modern 调度应使用短生命周期子进程，并让外部聊天宿主用前台租约覆盖完整回复窗口；精确 canary 必须指定 target，不能顺带消费全库积压。
