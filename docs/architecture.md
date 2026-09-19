# Architecture

The system operationalizes Kahneman's dual-process model: a fast, calibrated, cheap decision layer (System 1) handles the bulk of routing, and a slow, expensive reasoning layer (System 2) handles what the fast layer escalates. Everything between them is a threshold fitted on labeled data — never a hardcoded guess.

## Components

```
┌────────────────────────── request ──────────────────────────┐
│                                                            │
│  memory.py         Graft (code/project memory, live)        │
│                    + Mem0 (semantic memory, pluggable)      │
│         │                                                  │
│         ▼                                                  │
│  router.py         ONE batched Jev call:                   │
│                    intent (choice)                          │
│                    safety (noul)                            │
│                    complexity (score)                       │
│         │                                                  │
│         ├── gates: keywords → other-fallback → intent-conf  │
│         │           → safety bands → complexity cap        │
│         │                                                  │
│         ├── system1_auto ──▶ injection gate ──▶ host runs  │
│         │                     (clean | flagged band)        │
│         └── system2 ────────▶ system2.py ──▶ GLM-5.3         │
│                                (context + reasons attached)│
│                                                            │
│  hybrid.py         dispatch(): full loop, end-to-end       │
│                    latency + total cost per request         │
└────────────────────────────────────────────────────────────┘
```

## Cost and latency envelope (measured, 2026-09-19)

| Path | Latency | Cost |
|---|---|---|
| Jev decision (routing) | ~350 ms | ~$0.00002 |
| Full System-1 auto path (incl. retrieval + injection gate) | ~1.1 s | ~$0.00005 |
| System-2 (GLM-5.3, one deep request) | ~105 s | ~$0.033 |

A System-2 call costs ~670× a System-1 decision. The §7.5 cost-reduction target (≥40% vs pure System-2) holds at escalation rates up to ~60%; at the intended ~30% escalation the system saves ~70%.

## Routing policy (implemented order)

1. Retrieve memory (Graft; Mem0 if `MEM0_API_KEY` set) and prepend to state.
2. One batched Jev call answers all three questions atomically.
3. Apply gates in order — first failure decides:
   - **Force keywords** (`architecture|security|refactor|migrate|design`) → system2
   - **`intent = other`** → system2 (never force a listed category)
   - **intent confidence < 0.75** → system2
   - **safety noul < 0.50** → system2; **0.50–0.75** → auto + flag; **≥ 0.75** → clean auto
   - **complexity score > 1.5** (levels 0–4) → system2
4. If still auto: run the serial **injection gate** over the full state (request + retrieved context). noul ≥ 0.80 → system2; unavailable check → conservative escalation.
5. Medium intent-confidence band (0.75–0.90) or safety-flagged band → `needs_review = true` (feeds the audit sampling pool).
6. Log everything: full distributions, thresholds applied, reasons, `decision_id`.

Why bands instead of one threshold: the safety noul is **bimodal** (unsafe ≤ 0.17, safe ≥ 0.50 across n=100). A single high cut reads mid-range probabilities as "probably unsafe" and blocked 100% of auto-execution (the §14.2 finding). Bands also fail soft under drift — clean → flagged before auto → escalate.

## Memory layer

- **Graft**: local CLI (`graft ask --source`), ~1500 chars of context, injected into the Jev state. Contribution measured as a **boundary effect** (changes decisions near thresholds, not mean confidence).
- **Mem0**: REST retriever, activates only when `MEM0_API_KEY` is set; degrades to Graft-only with a logged note. Unvalidated against the real API — treat as scaffolding until first live use.
- Retrieved context is **untrusted input** — that is why the injection gate checks the full state, not just the request.

## System-2 consumer

- Provider: `z-ai/glm-5.3` via OpenRouter chat completions (`SYSTEM2_MODEL` overrides).
- Prompt = system role + request + retrieved context + the router's recorded escalation reasons.
- Linked to the routing decision by `decision_id`; cost and latency logged per call.
- Escalated decisions skip the injection gate — System 2 sees raw text with full scrutiny.

## Logging topology

| File | Written by | Key fields |
|---|---|---|
| `evals/logs/decisions.jsonl` | jev_client | every raw Jev call: questions, state, answers, usage, resolved model |
| `evals/logs/routing.jsonl` | router | decision_id, decision, needs_review, reasons, full answers, integrity noul, latency |
| `evals/logs/system2.jsonl` | system2 | decision_id, model, usage (cost), latency, response size |
| `evals/logs/bmad_gates.jsonl` | bmad_gates | transition, verdict, gates_failed, blocker_kind, answers |
| `evals/logs/judge.jsonl` | judge | verdict, failure_kind, gate nouls, dimension scores |

Logs are runtime artifacts (gitignored); golden sets, criteria, results, and baselines are committed.

## Failure semantics

Every module returns explicit statuses — `disabled`, `unavailable` with a machine-readable reason — and callers fall back to ordinary behavior. Retries are bounded (1–2, backoff on 429/5xx only). Nothing succeeds silently; nothing auto-executes when its safety check could not run.