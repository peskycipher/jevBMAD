#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Unit tests: structured score criteria + Retry-After honoring.

Per the repo doctrine (CONTRIBUTING.md), behavior changes need unit-test
coverage. These cover all three lockstep adapter copies and the harness
client, and run offline (no API key, no network).
"""

import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]

ADAPTER_COPIES = [
    ROOT / "modules/bmad-jev/bmad-jev-decide/scripts/jev_adapter.py",
    ROOT / "_bmad/scripts/jev_adapter.py",
    ROOT / ".agents/skills/bmad/scripts/jev_adapter.py",
]
CLIENT_COPY = ROOT / "evals/harness/jev_client.py"


def load_module(path: Path, name: str):
    sys.path.insert(0, str(path.parent))
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module  # dataclasses resolves types via sys.modules
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(path.parent))


OBJECT_CRITERIA = [
    {"what": "Cosmetic", "examples": ["typo"]},
    {"what": "Degraded", "examples": ["slow"]},
    {"what": "Blocking", "examples": ["crash"]},
]
STRING_CRITERIA = ["Cosmetic", "Degraded", "Blocking"]


def score_answer(score=1.0, confidence=0.9, probabilities=None, legend=None):
    answer = {
        "type": "score",
        "score": score,
        "confidence": confidence,
        "probabilities": probabilities or {"0": 0.0, "1": 1.0, "2": 0.0},
    }
    if legend is not None:
        answer["legend"] = legend
    return answer


def score_body(answer):
    return json.dumps({"model": "jev-1.13.0", "answers": {"severity": answer},
                       "usage": {"input_tokens": 10, "output_tokens": 1}}).encode()


class StructuredScoreCriteriaTest(unittest.TestCase):
    """Score criteria entries may be strings or objects (docs.typesafe.ai
    primitives/score#structured-level-descriptions)."""

    def test_object_criteria_and_object_legend_pass(self):
        for i, path in enumerate(ADAPTER_COPIES):
            with self.subTest(copy=str(path)):
                mod = load_module(path, f"jev_adapter_obj_legend_{i}")
                questions = {"severity": {"type": "score", "instructions": "How severe?",
                                          "criteria": OBJECT_CRITERIA}}
                answer = score_answer(legend={"1": OBJECT_CRITERIA[1]})
                validated, error = mod._validate_answers(questions, {"severity": answer})
                self.assertIsNone(error)
                self.assertEqual(validated["severity"]["score"], 1.0)

    def test_object_criteria_with_string_legend_pass(self):
        for i, path in enumerate(ADAPTER_COPIES):
            with self.subTest(copy=str(path)):
                mod = load_module(path, f"jev_adapter_str_legend_{i}")
                questions = {"severity": {"type": "score", "instructions": "How severe?",
                                          "criteria": OBJECT_CRITERIA}}
                answer = score_answer(legend={"1": "Degraded"})
                validated, error = mod._validate_answers(questions, {"severity": answer})
                self.assertIsNone(error)

    def test_object_criteria_reject_out_of_range_level(self):
        mod = load_module(ADAPTER_COPIES[0], "jev_adapter_obj_range")
        questions = {"severity": {"type": "score", "instructions": "How severe?",
                                  "criteria": OBJECT_CRITERIA}}
        answer = score_answer(probabilities={"0": 0.0, "1": 0.0, "5": 1.0})
        _, error = mod._validate_answers(questions, {"severity": answer})
        self.assertIn("non-supplied rubric level", error)

    def test_single_level_criteria_still_rejected(self):
        mod = load_module(ADAPTER_COPIES[0], "jev_adapter_single_level")
        questions = {"severity": {"type": "score", "instructions": "How severe?",
                                  "criteria": ["Only one"]}}
        _, error = mod._validate_answers(questions, {"severity": score_answer()})
        self.assertIn("at least 2 strings or objects", error)

    def test_string_criteria_legend_mismatch_still_rejected(self):
        mod = load_module(ADAPTER_COPIES[0], "jev_adapter_legend_regress")
        questions = {"severity": {"type": "score", "instructions": "How severe?",
                                  "criteria": STRING_CRITERIA}}
        answer = score_answer(legend={"1": "something else"})
        _, error = mod._validate_answers(questions, {"severity": answer})
        self.assertIn("legend does not match", error)

    def test_choice_structured_option_descriptions_pass(self):
        mod = load_module(ADAPTER_COPIES[0], "jev_adapter_choice_objects")
        questions = {"dept": {"type": "choice", "instructions": "Which team?",
                              "criteria": {"billing": {"covers": "payments"},
                                           "technical": {"covers": "bugs"}}}}
        answer = {"type": "choice", "choice": "technical", "confidence": 0.9,
                  "probabilities": {"billing": 0.1, "technical": 0.9}}
        validated, error = mod._validate_answers(questions, {"dept": answer})
        self.assertIsNone(error)
        self.assertEqual(validated["dept"]["choice"], "technical")


class AdapterRetryAfterTest(unittest.TestCase):
    def test_429_with_retry_after_is_honored_then_succeeds(self):
        mod = load_module(ADAPTER_COPIES[0], "jev_adapter_retry")
        settings = mod.JevSettings(
            mode="suggest", model="m", endpoint="https://example.invalid/v1",
            api_key="k", timeout_seconds=1.0, max_retries=1,
            max_calls=4, max_state_chars=4000,
        )
        calls = {"n": 0}
        sleeps: list[float] = []

        def transport(url, payload, timeout):
            calls["n"] += 1
            if calls["n"] == 1:
                return 429, b"rate limited", {"Retry-After": "0.01"}
            return 200, score_body(score_answer(legend={"1": OBJECT_CRITERIA[1]})), None

        with mock.patch.object(mod.time, "sleep", side_effect=sleeps.append):
            client = mod.JevClient(settings, transport=transport)
            result = client.post_decision(
                operation="test", state="s",
                questions={"severity": {"type": "score", "instructions": "How severe?",
                                        "criteria": OBJECT_CRITERIA}},
            )
        self.assertEqual(result.status, "ok")
        self.assertEqual(calls["n"], 2)
        self.assertAlmostEqual(sleeps[0], 0.01, places=3)

    def test_retry_after_capped(self):
        mod = load_module(ADAPTER_COPIES[0], "jev_adapter_retry_cap")
        self.assertEqual(mod._retry_after_seconds({"Retry-After": "3600"}),
                         mod.RETRY_AFTER_CAP_SECONDS)
        self.assertEqual(mod._retry_after_seconds({"Retry-After": "0"}), 0.0)
        self.assertIsNone(mod._retry_after_seconds({"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"}))
        self.assertIsNone(mod._retry_after_seconds(None))


class ClientRetryAfterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_module(CLIENT_COPY, "jev_client_test")

    def test_numeric_value_returned(self):
        self.assertEqual(self.mod._retry_after_seconds({"Retry-After": "1.5"}), 1.5)

    def test_cap_applied(self):
        self.assertEqual(self.mod._retry_after_seconds({"Retry-After": "999"}),
                         self.mod.RETRY_AFTER_CAP_SECONDS)

    def test_http_date_form_falls_back(self):
        self.assertIsNone(self.mod._retry_after_seconds({"Retry-After": "not-a-number"}))

    def test_missing_header_falls_back(self):
        self.assertIsNone(self.mod._retry_after_seconds(None))
        self.assertIsNone(self.mod._retry_after_seconds({}))

    def test_no_key_raises_provider_agnostic_error(self):
        import os
        env_backup = {k: os.environ.pop(k) for k in ("TYPESAFE_API_KEY", "OPENROUTER_API_KEY") if k in os.environ}
        try:
            with self.assertRaises(self.mod.JevError) as ctx:
                self.mod.call_jev({"q": {"type": "noul", "instructions": "x"}}, "state")
            self.assertIn("TYPESAFE_API_KEY", str(ctx.exception))
        finally:
            os.environ.update(env_backup)


if __name__ == "__main__":
    unittest.main()
