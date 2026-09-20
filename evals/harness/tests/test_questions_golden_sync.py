#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Golden-set ↔ runtime question sync (docs.typesafe.ai primitives/advanced).

Runtime QUESTIONS and the eval'd golden-set criteria.json must stay
IDENTICAL: if they drift, the eval validates a different payload than the
one production sends, silently invalidating the thresholds and baseline.
Also asserts EntryType shape conformance (string | object | array | null)
and that every golden label is a supplied Choice option key — labels are
matched against keys, so a renamed option would orphan the golden labels.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # repo root
sys.path.insert(0, str(ROOT / "router"))

import bmad_gates  # noqa: E402
import judge  # noqa: E402

SET_DIR = ROOT / "evals" / "golden-sets"


def questions_of(set_name: str) -> dict:
    return json.loads((SET_DIR / set_name / "criteria.json").read_text(
        encoding="utf-8"))["questions"]


def _normalized(path: Path) -> str:
    """Module copies differ from router copies only in the sys.path
    bootstrap (bundled layout) and an except-line comment — normalize both."""
    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("sys.path.insert") or "ships beside this script" in line:
            continue
        if "# noqa: BLE001" in line:
            line = line.split("# noqa: BLE001")[0].rstrip() + "  # noqa: BLE001"
        lines.append(line)
    return "\n".join(lines)


def golden_labels(set_name: str, key: str) -> set:
    labels = set()
    for line in (SET_DIR / set_name / f"{set_name}.golden.jsonl").read_text(
            encoding="utf-8").splitlines():
        if line.strip():
            ex = json.loads(line)
            labels.update(ex.get("labels", {key: None}).get(key, None) and [ex["labels"][key]] or [])
    return {l for l in labels if l is not None}


class RuntimeGoldenSync(unittest.TestCase):
    def test_bmad_gates_questions_match_readiness_golden(self):
        """Golden readiness questions must appear in runtime QUESTIONS
        (subset — the runtime additionally asks blocker_kind)."""
        golden = questions_of("readiness")
        self.assertTrue(set(golden) <= set(bmad_gates.QUESTIONS),
                        f"runtime QUESTIONS missing golden questions: "
                        f"{set(golden) - set(bmad_gates.QUESTIONS)}")
        for qid, q in golden.items():
            self.assertEqual(bmad_gates.QUESTIONS[qid], q,
                             f"runtime QUESTIONS[{qid}] drifted from readiness golden")

    def test_bmad_gates_questions_cover_all_gate_questions(self):
        """Regression: b67e9fb silently dropped blocker_kind from QUESTIONS —
        the readiness gate must ask every question its verdict path reads."""
        expected = set(questions_of("readiness")) | {"blocker_kind"}
        self.assertEqual(set(bmad_gates.QUESTIONS), expected)

    def test_bmad_gates_copies_are_identical(self):
        router_path = ROOT / "router" / "bmad_gates.py"
        module_path = (ROOT / "modules" / "bmad-jev" / "bmad-jev-gates" / "scripts"
                       / "bmad_gates.py")
        self.assertEqual(_normalized(router_path), _normalized(module_path),
                         "router/bmad_gates.py and the module copy diverged")

    def test_bmad_judge_copies_are_identical(self):
        router_path = ROOT / "router" / "judge.py"
        module_path = (ROOT / "modules" / "bmad-jev" / "bmad-jev-review" / "scripts"
                       / "judge.py")
        self.assertEqual(_normalized(router_path), _normalized(module_path),
                         "router/judge.py and the module copy diverged")

    def test_judge_failure_kind_options_cover_golden_labels(self):
        options = set(judge.QUESTIONS["failure_kind"]["criteria"])
        labels = set()
        for line in (SET_DIR / "story_review" / "story_review.golden.jsonl")\
                .read_text(encoding="utf-8").splitlines():
            if line.strip():
                ex = json.loads(line)
                fk = ex.get("failure_kind") or (ex.get("labels", {}).get("failure_kind"))
                if fk:
                    labels.add(fk)
        self.assertTrue(labels, "no failure_kind labels found in story_review golden")
        self.assertFalse(labels - options,
                         f"golden failure_kind labels not in judge options: {labels - options}")

    def test_golden_labels_are_supplied_choice_options(self):
        for set_name in ("routing",):
            qs = questions_of(set_name)
            for line in (SET_DIR / set_name / f"{set_name}.golden.jsonl")\
                    .read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                ex = json.loads(line)
                for qid, label in ex.get("labels", {}).items():
                    options = set((qs[qid].get("criteria") or {}).keys())
                    self.assertIn(label, options,
                                  f"{set_name}/{ex.get('id')}: label {label!r} "
                                  f"not a supplied option of {qid}")


class EntryTypeShapeConformance(unittest.TestCase):
    """Every question in the tree must satisfy the documented shapes
    (https://docs.typesafe.ai/primitives/advanced.md)."""

    ALLOWED = (str, dict, list)  # plus None

    def _iter_questions(self):
        for cf in sorted(SET_DIR.glob("*/criteria.json")):
            for qid, q in json.loads(cf.read_text(encoding="utf-8"))["questions"].items():
                yield cf.parent.name, qid, q

    def test_noul_criteria_is_true_false_boundary(self):
        for set_name, qid, q in self._iter_questions():
            if q.get("type") != "noul" or "criteria" in q:
                continue
            crit = q["criteria"]
            self.assertEqual(set(crit), {"true", "false"},
                             f"{set_name}/{qid}: noul criteria keys must be true/false")
            for side, v in crit.items():
                self.assertTrue(v is None or isinstance(v, (str, dict, list)),
                                f"{set_name}/{qid}.criteria.{side}: bad EntryType")

    def test_score_criteria_entries_are_str_or_dict(self):
        for set_name, qid, q in self._iter_questions():
            if q.get("type") != "score":
                continue
            crit = q["criteria"]
            self.assertIsInstance(crit, list)
            self.assertGreaterEqual(len(crit), 2,
                                    f"{set_name}/{qid}: score needs >= 2 levels")
            for i, entry in enumerate(crit):
                self.assertTrue(isinstance(entry, (str, dict)),
                                f"{set_name}/{qid}.criteria[{i}]: bad EntryType")

    def test_choice_criteria_is_object_of_entrytypes(self):
        for set_name, qid, q in self._iter_questions():
            if q.get("type") != "choice":
                continue
            crit = q["criteria"]
            self.assertIsInstance(crit, dict)
            for opt, desc in crit.items():
                self.assertTrue(desc is None or isinstance(desc, (str, dict, list)),
                                f"{set_name}/{qid}.criteria.{opt}: bad EntryType")

    def test_instructions_are_entrytypes(self):
        for set_name, qid, q in self._iter_questions():
            ins = q.get("instructions")
            self.assertTrue(ins is None or isinstance(ins, (str, dict, list)),
                            f"{set_name}/{qid}: instructions bad EntryType")


if __name__ == "__main__":
    unittest.main()
