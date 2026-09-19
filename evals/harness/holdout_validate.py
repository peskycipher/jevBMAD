#!/usr/bin/env python3
"""Held-out validation (implementation.md §6: fit on train, validate on holdout).

Corrects the methodology error of fitting and reporting on the same data:

  1. Deterministic stratified 80/20 split per golden set (written once to
     golden-sets/<set>/splits/ and reused — never reshuffled, or the holdout
     leaks). Stratified by exact label signature.
  2. Live Jev run over the full set (fresh predictions, ids recorded).
  3. Thresholds fitted on the TRAIN split only.
  4. Unbiased estimates reported on the HOLDOUT split — at both the
     train-fitted thresholds and the locked production thresholds (§10
     strictest-of rule), so eval numbers and production decision boundaries
     finally measure the same thing.

Sets with < 20 examples (readiness, story_review) are skipped: too small to
split; their numbers remain provisional per the known-limitations note.

Usage:
  python3 evals/harness/holdout_validate.py          # big sets (default)
  python3 evals/harness/holdout_validate.py routing guardrails
"""
from __future__ import annotations

import json
import random
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "router"))

import run_evals  # noqa: E402
from fit_thresholds import DEFAULTS, sweep_confidence, sweep_noul, sweep_score  # noqa: E402
from jev_client import call_jev  # noqa: E402

GOLDEN = HERE.parent / "golden-sets"
RESULTS = HERE.parent / "results"
LOCKFILE = ROOT / "router" / "thresholds.lockfile.json"
SEED = 42
TRAIN_FRAC = 0.8
MIN_SET_SIZE = 20  # below this, splitting is statistically meaningless


def make_split(set_dir: Path, examples: list) -> dict:
    """Deterministic stratified split, written once and reused thereafter."""
    sp = set_dir / "splits"
    meta_p, train_p, hold_p = sp / "meta.json", sp / "train.jsonl", sp / "holdout.jsonl"
    if meta_p.exists() and train_p.exists() and hold_p.exists():
        train_ids = {json.loads(l)["id"] for l in train_p.read_text().splitlines() if l.strip()}
        hold_ids = {json.loads(l)["id"] for l in hold_p.read_text().splitlines() if l.strip()}
        return {"train": train_ids, "holdout": hold_ids, "reused": True}
    sp.mkdir(parents=True, exist_ok=True)
    strata = defaultdict(list)
    for ex in examples:
        strata[json.dumps(ex["labels"], sort_keys=True)].append(ex["id"])
    train_ids, hold_ids = set(), set()
    rng = random.Random(SEED)
    for ids in strata.values():
        ids = sorted(ids)
        rng.shuffle(ids)
        k = max(1, round(len(ids) * (1 - TRAIN_FRAC)))
        hold_ids.update(ids[:k])
        train_ids.update(ids[k:])
    train_p.write_text("".join(json.dumps({"id": i}) + "\n" for i in sorted(train_ids)))
    hold_p.write_text("".join(json.dumps({"id": i}) + "\n" for i in sorted(hold_ids)))
    meta_p.write_text(json.dumps({"seed": SEED, "train_frac": TRAIN_FRAC,
                                  "n_train": len(train_ids), "n_holdout": len(hold_ids),
                                  "strata": len(strata)}, indent=2))
    return {"train": train_ids, "holdout": hold_ids, "reused": False}


def eval_at_threshold(records, prim, threshold, mode):
    """Accuracy among records whose production decision is 'auto' at threshold.

    The thresholded value is `confidence` for choice (a distribution-
    concentration statistic) and `prediction` for noul/score (the answer
    itself). mode 'ge': auto when value >= threshold; 'le': <= (complexity cap).
    """
    def value(r):
        return r["confidence"] if prim == "choice" else r["prediction"]

    auto = [r for r in records if r["primitive"] == prim and
            ((value(r) >= threshold) if mode == "ge" else (value(r) <= threshold))]
    if not auto:
        return {"n_auto": 0, "auto_acc": None}
    return {"n_auto": len(auto), "auto_acc": round(sum(r["correct"] for r in auto) / len(auto), 3)}


def main(argv):
    sets = argv[1:] or ["routing", "guardrails", "complexity"]
    lock = json.loads(LOCKFILE.read_text()) if LOCKFILE.exists() else {}
    locked = {**DEFAULTS, **lock.get("locked", {})}
    report_all = []

    for name in sets:
        set_dir = GOLDEN / name
        if not (set_dir / "criteria.json").exists():
            print(f"skip {name}: no criteria.json")
            continue
        criteria, examples = run_evals.load_set(set_dir)
        if len(examples) < MIN_SET_SIZE:
            print(f"skip {name}: {len(examples)} examples < {MIN_SET_SIZE} (too small to split; stays provisional)")
            continue

        split = make_split(set_dir, examples)
        # fresh live run with ids
        rep = run_evals.run_set(set_dir)
        records = rep["records"]
        by_id = defaultdict(list)
        for r in records:
            by_id[r["id"]].append(r)
        train = [r for i in split["train"] for r in by_id[i]]
        hold = [r for i in split["holdout"] for r in by_id[i]]
        assert len(train) + len(hold) == len(records)

        # ---- fit on TRAIN only ----
        fitted = {}
        if name == "routing":
            recs = [r for r in train if r["primitive"] == "choice"]
            fitted["intent_conf_min"] = sweep_confidence(recs)
        elif name == "guardrails":
            recs = [r for r in train if r["primitive"] == "noul"]
            fitted["safe_noul_min"] = sweep_noul(recs)
        elif name == "complexity":
            recs = [r for r in train if r["primitive"] == "score"]
            fitted["complexity_max"] = sweep_score(recs)

        # ---- evaluate on HOLDOUT ----
        out = {"set": name, "n_train": len(split["train"]), "n_holdout": len(split["holdout"]),
               "split_reused": split["reused"], "model": rep["model_resolved"],
               "train_accuracy": None, "holdout_accuracy": rep["accuracy"],
               "fitted_on_train": {}, "holdout_at_fitted": {}, "holdout_at_locked": {}}

        if name == "routing":
            choice_hold = [r for r in hold if r["primitive"] == "choice"]
            out["holdout_accuracy"] = sum(r["correct"] for r in choice_hold) / len(choice_hold)
            choice_train = [r for r in train if r["primitive"] == "choice"]
            out["train_accuracy"] = sum(r["correct"] for r in choice_train) / len(choice_train)
            t_fit = fitted["intent_conf_min"][0]
            out["fitted_on_train"] = {"intent_conf_min": t_fit,
                                      "auto_acc_train": round(fitted["intent_conf_min"][1], 3)}
            out["holdout_at_fitted"] = {"threshold": t_fit,
                                        **eval_at_threshold(choice_hold, "choice", t_fit, "ge")}
            t_lock = locked["intent_conf_min"]
            out["holdout_at_locked"] = {"threshold": t_lock,
                                        **eval_at_threshold(choice_hold, "choice", t_lock, "ge")}
        elif name == "guardrails":
            noul_hold = [r for r in hold if r["primitive"] == "noul"]
            out["holdout_accuracy"] = sum(r["correct"] for r in noul_hold) / len(noul_hold)
            noul_train = [r for r in train if r["primitive"] == "noul"]
            out["train_accuracy"] = sum(r["correct"] for r in noul_train) / len(noul_train)
            t_fit = fitted["safe_noul_min"][0]
            out["fitted_on_train"] = {"safe_noul_min": t_fit,
                                      "auto_acc_train": round(fitted["safe_noul_min"][1], 3)}
            out["holdout_at_fitted"] = {"threshold": t_fit,
                                        **eval_at_threshold(noul_hold, "noul", t_fit, "ge")}
            t_lock = locked["safe_noul_min"]
            out["holdout_at_locked"] = {"threshold": t_lock,
                                        **eval_at_threshold(noul_hold, "noul", t_lock, "ge")}
        elif name == "complexity":
            out["holdout_accuracy"] = sum(r["correct"] for r in hold) / len(hold)
            out["train_accuracy"] = sum(r["correct"] for r in train) / len(train)
            mae_h = sum(abs(r["prediction"] - r["label"]) for r in hold) / len(hold)
            t_fit = fitted["complexity_max"][0]
            out["fitted_on_train"] = {"complexity_max": t_fit,
                                      "auto_acc_train": round(fitted["complexity_max"][1], 3)}
            out["holdout_at_fitted"] = {"threshold": t_fit, "holdout_mae": round(mae_h, 3),
                                        **eval_at_threshold(hold, "score", t_fit, "le")}
            t_lock = locked["complexity_max"]
            out["holdout_at_locked"] = {"threshold": t_lock,
                                        **eval_at_threshold(hold, "score", t_lock, "le")}

        report_all.append(out)
        print(json.dumps(out, indent=2))

    out_path = RESULTS / f"holdout-validation-{__import__('time').strftime('%Y%m%d-%H%M%S')}.json"
    out_path.write_text(json.dumps(report_all, indent=2), encoding="utf-8")
    print(f"\nreport: {out_path}")


if __name__ == "__main__":
    main(sys.argv)