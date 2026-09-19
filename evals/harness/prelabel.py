#!/usr/bin/env python3
"""Jev-assisted golden-set pre-labeling (implementation.md §7.6, Phase 3).

The scalable path to >=100 labeled examples per set (§6): propose labels with
Jev, queue for human confirmation (~audit), then promote approved rows.

  1. `--generate <set> <candidates.jsonl>` — candidates are {"state": ...}
     rows; Jev proposes a label per question using the set's criteria.
     Proposals land in evals/audit/prelabel_queue.jsonl with "approved": false.
  2. A human edits the queue, setting "approved": true and fixing labels.
  3. `--promote <set>` — approved rows are appended to the golden set with a
     `source: "jev-prelabel+human-confirm"` provenance field.

Usage:
  python3 evals/harness/prelabel.py --generate routing candidates.jsonl
  python3 evals/harness/prelabel.py --promote routing
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from jev_client import call_jev  # noqa: E402

GOLDEN = HERE.parent / "golden-sets"
AUDIT = HERE.parent / "audit"
QUEUE = AUDIT / "prelabel_queue.jsonl"


def generate(set_name: str, candidates_path: Path) -> None:
    set_dir = GOLDEN / set_name
    questions = json.loads((set_dir / "criteria.json").read_text())["questions"]
    candidates = [json.loads(l) for l in candidates_path.read_text().splitlines() if l.strip()]
    AUDIT.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(QUEUE, "a", encoding="utf-8") as f:
        for i, cand in enumerate(candidates):
            resp = call_jev(questions, cand["state"])
            labels = {}
            for qid, ans in resp["answers"].items():
                if ans["type"] == "noul":
                    labels[qid] = 1 if ans["noul"] >= 0.5 else 0
                elif ans["type"] == "choice":
                    labels[qid] = ans["choice"]
                else:  # score: nearest level
                    labels[qid] = round(ans["score"])
            row = {"set": set_name, "id": f"{set_name}-pre-{int(__import__('time').strftime('%s'))}-{i}",
                   "state": cand["state"], "proposed_labels": labels,
                   "answers": resp["answers"], "approved": False,
                   "final_labels": None}
            f.write(json.dumps(row) + "\n")
            n += 1
    print(f"queued {n} proposals -> {QUEUE} (human review required before promote)")


def promote(set_name: str) -> None:
    set_dir = GOLDEN / set_name
    golden_path = set_dir / f"{set_name}.golden.jsonl"
    _existing = [json.loads(l) for l in golden_path.read_text().splitlines() if l.strip()]
    existing_ids = {r["id"] for r in _existing}
    existing_states = {r["state"] for r in _existing}  # dedupe by content, not just id
    queue = [json.loads(l) for l in QUEUE.read_text().splitlines() if l.strip()]
    promoted = 0
    with open(golden_path, "a", encoding="utf-8") as f:
        for row in queue:
            if row.get("set") != set_name or not row.get("approved"):
                continue
            if row["id"] in existing_ids or row["state"] in existing_states:
                continue  # id or duplicate content already in the set
            labels = row.get("final_labels") or row["proposed_labels"]
            f.write(json.dumps({"id": row["id"], "state": row["state"],
                                "labels": labels,
                                "source": "jev-prelabel+human-confirm"}) + "\n")
            existing_ids.add(row["id"])
            promoted += 1
    print(f"promoted {promoted} approved examples into {golden_path}")


def main(argv):
    if "--generate" in argv:
        set_name = argv[argv.index("--generate") + 1]
        generate(set_name, Path(argv[argv.index("--generate") + 2]))
    elif "--promote" in argv:
        promote(argv[argv.index("--promote") + 1])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)