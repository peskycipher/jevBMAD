# Labeling Protocol (companion)

Procedure for CAP-1: how to collect and label samples so the batch is genuinely independent.

## Sample collection

1. Sample 15–25 candidate states from the production decision log (`evals/logs/routing.jsonl`) and, where thin, the online-sample pool — **before** any judge pass on them. Record each state verbatim with its `decision_id`.
2. Freeze the sample set first (commit the unlabeled file); only then may labeling begin. Freezing before labeling makes "labeler saw Jev's output" auditable by timestamp.

## Blind labeling procedure

1. For each sample, the labeler sees **only the raw state** (request text, any retrieved context) plus the question definition from `criteria.json` / §7.7 rubric — never Jev's answer, confidence, or distribution.
2. Label per the existing taxonomies: routing intent (choice), safety (noul), complexity (score), and for story-review samples the §7.7 verdict + failure taxonomy.
3. Ambiguity rule (inherited from the prelabel pipeline): an ambiguous label is recorded as `ambiguous` and dropped from agreement scoring — coin-flip labels never enter ground truth. Ambiguous rows stay in the file for the record.

## Provenance format

Each line of the batch file (`evals/audit-independent/batch.jsonl`) carries:

```json
{"id": "...", "decision_id": "...", "state": "...", "taxonomy": "routing|guardrails|complexity|story_review",
 "human_label": {...}, "labeled_at": "<ts>", "labeler": "loki",
 "blind": true, "jev_output_seen": false, "notes": "..."}
```

`jev_output_seen` is a per-label attestation. Any row where Jev's output was seen before labeling must be marked and is excluded from calibration scoring (auditable, §14.1.3 style).

## After labeling

1. Run the judge over the same frozen samples (`judge.py` / routing replay) and produce the agreement report (CAP-2).
2. Do not promote any independent label into a golden set. The batch is read-only calibration data.

## Ordering gate (CAP-2 refuses to score otherwise)

The agreement report refuses to score unless the human-label commit (timestamp, git SHA) precedes the judge run over the same batch. Ordering is part of the report's own output, not a narrative claim.

## Judge isolation

The judge pass runs in a clean environment that does **not** mount the labeling workspace: separate session, no shared shell history, no access to the labeling shell's `evals/logs/decisions.jsonl`. "Labeler never saw Jev's output" must have no backdoor through the filesystem.

## Batch split (fatigue control)

Two labeling sessions: the first ~10 labels drawn from the existing online-sample pool (speed), the remainder from fresh production traffic. Sessions are separated in time; per-session labels are flagged in provenance (`session: 1|2`) so order effects are auditable.