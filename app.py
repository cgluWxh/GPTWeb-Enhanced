from __future__ import annotations

from server.app_base import AppConfig, Application


app = Application(
    AppConfig(
        id="gptweb",
        display_name="GPT Web Enhanced",
        # 无 hosts：这是纯用户脚本应用，不占用平台子域。
        origins=(
            "https://chatgpt.com",
            "https://chat.openai.com",
            "https://www.chatgpt.com",
        ),
        client_config={},
    )
)
