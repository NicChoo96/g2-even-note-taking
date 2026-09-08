"""Seed the local relay with a deterministic baseline for simulator checks.

Usage: python tools/seed-agents-state.py [relay_url] [owner_token]

Writes two channel snapshots (hub + agents) with:
  * To-Do active with 2 tasks (so the switcher menu shows the section list)
  * 2 agents -- ag1 "Researcher" (tavily tool), ag2 "Summarizer" (no tools)
  * 2 sessions on ag1, newest first
"""
import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5198"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else "devownerecb53dde7bf41d07"
NOW = 1788874700000

HUB = {
    "activeSection": "todo",
    "sections": {
        "todo": [
            {"id": "t1", "text": "Review agent output", "done": False},
            {"id": "t2", "text": "Ship the Agents tab", "done": True},
        ],
        "docs": [
            {"id": "d1", "title": "Trading Cheat Sheet", "content": "RSI overbought/oversold\nMACD cross = signal", "updatedAt": NOW},
            {"id": "d2", "title": "Meeting Minutes", "content": "Ring nav + pairing shipped", "updatedAt": NOW},
        ],
        "notes": "",
    },
    "activeDocId": "d1",
    "updatedAt": NOW,
}

AGENTS = {
    "agents": [
        {
            "id": "ag1",
            "name": "Researcher",
            "systemPrompt": "You are a concise research assistant. Use the available tools when you need current information, then answer briefly in plain text.",
            "toolIds": ["tool-tavily"],
            "createdAt": NOW,
        },
        {
            "id": "ag2",
            "name": "Summarizer",
            "systemPrompt": "Summarise the user's text in three bullet points.",
            "toolIds": [],
            "createdAt": NOW,
        },
    ],
    "tools": [
        {
            "id": "tool-tavily",
            "name": "tavily_search",
            "kind": "tavily",
            "description": "Search the web for current information.",
            "searchDepth": "basic",
            "hasToken": False,
        }
    ],
    "llm": {
        "provider": "openrouter",
        "model": "nvidia/nemotron-3.5-lightning:free",
        "hasKey": True,
    },
    "sessions": [
        {
            "id": "s2",
            "agentId": "ag1",
            "title": "What is G2?",
            "messages": [
                {"role": "user", "content": "What is G2?", "at": NOW},
                {"role": "assistant", "content": "G2 is Even Realities' display smart glasses.", "at": NOW},
            ],
            "status": "done",
            "createdAt": NOW,
            "updatedAt": NOW + 2000,
        },
        {
            "id": "s1",
            "agentId": "ag1",
            "title": "Even Realities pricing",
            "messages": [
                {"role": "user", "content": "Even Realities pricing?", "at": NOW},
                {"role": "assistant", "content": "The G2 frame is sold in a few regional variants.", "at": NOW},
            ],
            "status": "done",
            "createdAt": NOW,
            "updatedAt": NOW + 1000,
        },
    ],
    "updatedAt": NOW,
}


def publish(channel, state):
    req = urllib.request.Request(
        f"{BASE}/api/stream?channel={channel}",
        data=json.dumps(state).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode()


print("hub     ->", publish("hub", HUB))
print("agents  ->", publish("agents", AGENTS))
