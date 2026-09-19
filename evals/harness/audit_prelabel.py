#!/usr/bin/env python3
"""Audit Jev pre-label proposals against author-intended labels (§7.6).

For each queue row: if the proposal matches the author's intended label,
approve it (final_labels = intended). Otherwise drop it (approved stays
false) with a note — ambiguous candidates must not enter the golden set.

Usage:
  python3 evals/harness/audit_prelabel.py            # audit + rewrite queue
  python3 evals/harness/audit_prelabel.py --report  # stats only
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CANDIDATES = HERE.parent / "candidates"
QUEUE = HERE.parent / "audit" / "prelabel_queue.jsonl"


def main(argv):
    report_only = "--report" in argv

    intended = {}
    for cfile in CANDIDATES.glob("*.candidates.jsonl"):
        for l in cfile.read_text().splitlines():
            if l.strip():
                row = json.loads(l)
                intended[row["state"]] = row["intended"]  # states are unique across sets

    rows = [json.loads(l) for l in QUEUE.read_text().splitlines() if l.strip()]
    stats = {}
    out_rows = []
    for row in rows:
        intent = intended.get(row["state"])
        s = stats.setdefault(row["set"], {"total": 0, "agree": 0, "drop": 0, "no_intent": 0})
        s["total"] += 1
        if intent is None:
            s["no_intent"] += 1
            out_rows.append(row)
            continue
        agree = all(row["proposed_labels"].get(k) == v for k, v in intent.items())
        if agree:
            s["agree"] += 1
            if not report_only:
                row["approved"] = True
                row["final_labels"] = intent
                row["audit"] = "proposal matches author intent"
        else:
            s["drop"] += 1
            if not report_only:
                row["audit"] = (f"DROPPED: proposed {row['proposed_labels']} "
                                f"vs intended {intent} — ambiguous candidate")
        out_rows.append(row)

    print(json.dumps(stats, indent=2))
    for set_name, s in stats.items():
        if s["total"]:
            print(f"{set_name}: agreement {s['agree']}/{s['total'] - s['no_intent']} "
                  f"({s['agree'] / max(1, s['total'] - s['no_intent']):.1%})")
    if not report_only:
        QUEUE.write_text("".join(json.dumps(r) + "\n" for r in out_rows))
        print(f"queue rewritten: {QUEUE}")


if __name__ == "__main__":
    main(sys.argv)