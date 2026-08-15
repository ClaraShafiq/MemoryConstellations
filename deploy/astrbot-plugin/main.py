# memory-constellations-bridge
# 把 AstrBot 收到的消息转发到 Memory Constellations 记忆库的 /api/messages，
# 让记忆库的 Scribe 自动提取记忆。只负责「喂消息」，不负责回复。
#
# 配置记忆库地址：设置环境变量 MEMORY_API_BASE（默认 http://127.0.0.1:3000）
# Docker 部署时填 http://<记忆库容器名>:3000

import os
import aiohttp
from astrbot.api.star import Context, Star, filter
from astrbot.api.event import AstrMessageEvent

MEMORY_API_BASE = os.environ.get("MEMORY_API_BASE", "http://127.0.0.1:3000")


class MemoryConstellationsBridge(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    async def _send(self, sender: str, content: str):
        """POST 一条消息到记忆库，失败静默（不阻塞聊天）。"""
        content = (content or "").strip()
        if not content:
            return
        try:
            async with aiohttp.ClientSession() as session:
                await session.post(
                    f"{MEMORY_API_BASE}/api/messages",
                    json={"sender": sender, "content": content},
                    timeout=aiohttp.ClientTimeout(total=5),
                )
        except Exception:
            pass  # 记忆库不可用时静默跳过，不影响 AstrBot 正常聊天

    @filter.on_message()
    async def on_user_message(self, event: AstrMessageEvent):
        """用户发的消息 → 记忆库（sender=user）。"""
        await self._send("user", event.message_str)

    @filter.on_decorating_result()
    async def on_bot_reply(self, event: AstrMessageEvent):
        """机器人回复的消息 → 记忆库（sender=bot），让记忆库也记住它说过的话。"""
        try:
            # 机器人最终回复的纯文本
            reply = event.message_str or ""
        except Exception:
            reply = ""
        await self._send("bot", reply)
