#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Entrypoint degradation contract (adapter convention, repo-wide).

Every Jev entry point must return explicit status JSON — never a traceback —
when the provider is unavailable (missing OPENROUTER_API_KEY, HTTP errors).
Exit code 0: an unavailable outcome is a defined status, not a crash.
Mirrors jev_adapter.JevResult / jev_recommend status semantics.
"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # repo root

# (label, argv, cwd-relative dir, stdin required, expected status key)
CASES = [
    ("router.py", [sys.executable, "router/router.py", "test request"], "routing"),
    ("hybrid.py", [sys.executable, "router/hybrid.py", "test request"], "routing_decision"),
    ("bmad_gates.py", [sys.executable, "router/bmad_gates.py", "planning_to_solutioning"], "decision"),
    ("judge.py", [sys.executable, "router/judge.py", "/dev/null", "/dev/null"], "passed"),
    ("module gates copy", [sys.executable, "modules/bmad-jev/bmad-jev-gates/scripts/bmad_gates.py",
                           "planning_to_solutioning"], "decision"),
    ("module judge copy", [sys.executable, "modules/bmad-jev/bmad-jev-review/scripts/judge.py",
                           "/dev/null", "/dev/null"], "passed"),
    ("module recommend copy", [sys.executable, "modules/bmad-jev/bmad-jev-decide/scripts/jev_recommend.py",
                               "--request", "test", "--candidates", "a,b"], "status"),
    ("canonical recommend", [sys.executable, "_bmad/scripts/jev_recommend.py",
                             "--request", "test", "--candidates", "a,b"], "status"),
]


def run(label, argv, stdin_text):
    env = {**os.environ, "OPENROUTER_API_KEY": ""}  # force provider-unavailable
    proc = subprocess.run(argv, input=stdin_text, capture_output=True, text=True,
                          env=env, cwd=str(ROOT), timeout=60)
    return label, proc


class EntrypointDegradationTest(unittest.TestCase):
    def test_no_traceback_explicit_status_exit_zero(self):
        for label, argv, status_key in CASES:
            with self.subTest(entrypoint=label):
                stdin_text = "spec text\n" if "gates" in label else None
                _, proc = run(label, argv, stdin_text)
                self.assertNotIn("Traceback", proc.stderr,
                                 f"{label} leaked a traceback:\n{proc.stderr}")
                try:
                    data = json.loads(proc.stdout)
                except json.JSONDecodeError:
                    self.fail(f"{label} did not emit JSON on stdout: {proc.stdout!r}")
                self.assertIn("unavailable", json.dumps(data).lower(),
                              f"{label} should report an unavailable/disabled status")
                self.assertEqual(proc.returncode, 0,
                                 f"{label} should exit 0 on a defined unavailable status")


if __name__ == "__main__":
    unittest.main()