#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import re

import httpx


def main() -> None:
    parser = argparse.ArgumentParser(description="Подключить Telegram webhook к Worker")
    parser.add_argument("worker_url", help="Например: https://vyatsu-schedule-bot.name.workers.dev")
    args = parser.parse_args()

    token = getpass.getpass("BOT_TOKEN (ввод скрыт): ").strip()
    secret = getpass.getpass("WEBHOOK_SECRET (ввод скрыт): ").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", secret):
        raise ValueError("WEBHOOK_SECRET может содержать только A-Z, a-z, 0-9, _ и -")

    api = f"https://api.telegram.org/bot{token}"
    webhook_url = args.worker_url.rstrip("/") + "/telegram"
    commands = [
        {"command": "start", "description": "Открыть меню расписания"},
        {"command": "today", "description": "Расписание на сегодня"},
        {"command": "tomorrow", "description": "Расписание на завтра"},
        {"command": "aftertomorrow", "description": "Расписание на послезавтра"},
        {"command": "day", "description": "Выбрать конкретный день"},
        {"command": "week", "description": "Расписание на эту неделю"},
        {"command": "nextweek", "description": "Расписание на следующую неделю"},
        {"command": "settings", "description": "Выбрать подгруппу"},
    ]
    with httpx.Client(timeout=30) as client:
        command_response = client.post(f"{api}/setMyCommands", json={"commands": commands})
        command_response.raise_for_status()
        webhook_response = client.post(
            f"{api}/setWebhook",
            json={
                "url": webhook_url,
                "secret_token": secret,
                "drop_pending_updates": True,
            },
        )
        webhook_response.raise_for_status()
        payload = webhook_response.json()
        if not payload.get("ok"):
            raise RuntimeError(payload)
    print(f"Webhook установлен: {webhook_url}")


if __name__ == "__main__":
    main()
