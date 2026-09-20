"""Unified memory retrieval (implementation.md §2, step 1 of routing policy).

Combines:
  - Graft (Trail Brain): codebase structural & project memory, via local CLI
  - Mem0: general long-term semantic memory, via platform REST API
    (active only when MEM0_API_KEY is set; otherwise skipped gracefully)

The merged context is prepended to the Jev `state` for routing decisions.
"""
from __future__ import annotations

import json
import os
import subprocess
import urllib.request
from dataclasses import dataclass, field


@dataclass
class GraftRetriever:
    """Project/code memory via the local graft CLI (`graft ask --source`)."""

    project_root: str = "."
    max_chars: int = 1500

    def retrieve(self, query: str) -> str:
        try:
            out = subprocess.run(
                ["graft", "ask", query[:400], "--source"],
                cwd=self.project_root, capture_output=True, text=True, timeout=30,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            return f"[graft unavailable: {e}]"
        text = out.stdout.strip()
        return text[: self.max_chars] if text else "[graft: no context returned]"


@dataclass
class Mem0Retriever:
    """Long-term semantic memory via the Mem0 platform API.

    Disabled unless MEM0_API_KEY is set — the router logs a note and
    continues with Graft-only context (degraded, not failed).
    """

    top_k: int = 8
    min_score: float = 0.65  # §10 memory.mem0 config
    api_key: str = field(default_factory=lambda: os.environ.get("MEM0_API_KEY", ""))
    user_id: str = "default"

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def retrieve(self, query: str) -> str:
        if not self.available:
            return "[mem0: not configured (MEM0_API_KEY unset); graft-only context]"
        req = urllib.request.Request(
            "https://api.mem0.ai/v1/memories/search/",
            data=json.dumps({
                "query": query[:1000],
                "user_id": self.user_id,
                "filters": {"AND": [{"user_id": self.user_id}]},
                "top_k": self.top_k,
                "min_score": self.min_score,
            }).encode(),
            headers={"Authorization": f"Token {self.api_key}",
                     "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
        except Exception as e:  # noqa: BLE001
            return f"[mem0: search failed: {e}]"
        hits = [m.get("memory", "") for m in data.get("results", [])]
        return " | ".join(hits) if hits else "[mem0: no relevant memories]"


def retrieve_all(query: str, project_root: str = ".") -> dict:
    """Run both retrievers and return structured context for the router state."""
    graft = GraftRetriever(project_root=project_root).retrieve(query)
    mem0 = Mem0Retriever().retrieve(query)
    return {
        "graft": graft,
        "mem0": mem0,
        "mem0_active": Mem0Retriever().available,
    }


def format_context(ctx: dict) -> str:
    """Render retrieved memory into the state block fed to Jev."""
    return f"Project context (Graft):\n{ctx['graft']}\n\nLong-term memory (Mem0):\n{ctx['mem0']}"