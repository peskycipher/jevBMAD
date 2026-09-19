#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""System-1 model pin ↔ lockfile consistency (implementation.md §6).

The fitted thresholds in router/thresholds.lockfile.json are valid only for
the model they were fitted on (model_resolved). Every live jev_client /
jev_adapter copy must pin exactly that model, and it must be a dated
snapshot — a floating alias here silently invalidates the thresholds.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # repo root
LOCKFILE = ROOT / "router" / "thresholds.lockfile.json"

# every live copy that sends requests to the Decisions API
CLIENTS = [
    "evals/harness/jev_client.py",
    "modules/bmad-jev/bmad-jev-review/scripts/jev_client.py",
    "modules/bmad-jev/bmad-jev-gates/scripts/jev_client.py",
    "modules/bmad-jev/bmad-jev-decide/scripts/jev_adapter.py",
    "_bmad/scripts/jev_adapter.py",
]

DATED = re.compile(r"^typesafe/jev-[\w.]+-\d{8}$")


def pin_of(rel_path: str) -> str | None:
    src = (ROOT / rel_path).read_text(encoding="utf-8")
    m = re.search(r'DEFAULT_MODEL\s*=\s*"([^"]+)"', src)
    return m.group(1) if m else None


class ModelLockfileConsistencyTest(unittest.TestCase):
    def setUp(self):
        lock = json.loads(LOCKFILE.read_text(encoding="utf-8"))
        self.model = lock["model_resolved"]

    def test_lockfile_model_is_a_dated_snapshot(self):
        self.assertRegex(self.model, DATED,
                         "lockfile model_resolved must be a pinned dated snapshot")

    def test_every_live_client_pins_the_lockfile_model(self):
        for rel_path in CLIENTS:
            with self.subTest(client=rel_path):
                self.assertEqual(pin_of(rel_path), self.model,
                                 f"{rel_path} DEFAULT_MODEL drifted from "
                                 f"lockfile {self.model!r}")


if __name__ == "__main__":
    unittest.main()