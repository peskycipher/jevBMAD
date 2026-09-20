# Router Reference

Module-level reference for `router/`. All thresholds load from `router/thresholds.lockfile.json` (fallback defaults in code). All functions log unless disabled.

## `router/router.ts`

```python
route(request_text, project_root=".", use_memory=True,
      questions=None, thr=None, agent_id="default") -> dict
```

Returns: `decision_id`, `decision` (`system1_auto` | `system2`), `needs_review` (bool), `intent`, `intent_confidence`, `safe_noul`, `complexity_score`, `reasons` (list), `usage`, `model`, `latency_ms`.

Gate order (first failure decides system2): force keywords → `intent=other` → intent confidence < 0.75 → safety noul < 0.50 → complexity > 1.5. Clean-auto path then runs the injection gate (noul ≥ 0.80 → system2).

Questions (single source of truth: the golden-set criteria in `evals/golden-sets/*/criteria.json`):
- `intent` — choice: bug_fix / new_feature / question / refactor / docs_config / other
- `safe_auto` — noul: "safe to auto-execute without deeper review" (proposition-based; polarity-aligned)
- `complexity` — score 0–4: trivial / minor / moderate / major / critical

## `router/hybrid.ts`

```python
dispatch(request_text, project_root=".", use_memory=True) -> dict
```

Full loop. Returns the routing fields plus `system2` (model, text, latency, usage — or `{status: error}`), `end_to_end_ms`, `cost_usd` (routing + System-2). CLI: `npx tsx router/hybrid.ts "<request>"`.

## `router/system2.ts`

```python
execute(request_text, context="", reasons=None, decision_id="", log=True) -> dict
```

GLM-5.3 (`z-ai/glm-5.3`, override via `SYSTEM2_MODEL`) via OpenRouter chat completions. Prompt = system role + request + context + escalation reasons. Bounded retry (429/5xx). Returns `status`, `model`, `text`, `usage`, `latency_ms`.

## `router/bmad_gates.ts`

```python
check_readiness(artifact_text, transition="planning_to_solutioning",
                log=True, agent_id="default") -> dict
```

Transitions: `analysis_to_planning`, `planning_to_solutioning`, `solutioning_to_implementation`. Batched questions: `spec_specific` (noul ≥ 0.40), `requirements_testable` (noul ≥ 0.45), `no_blockers` (noul ≥ 0.55, with the "unfinished work ≠ blocker" instruction), `ready_score` (score ≥ 3.0), `blocker_kind` (choice taxonomy). Verdict: `proceed` only when all gates pass; otherwise `hold` + `blocker_kind`.

## `router/judge.ts`

```python
judge(story_text, implementation_text, log=True, agent_id="default") -> dict
```

§7.7 rubric, one batched call: gates `gate_spec` (≥ 0.75), `gate_no_regression` (≥ 0.65), `gate_security` (≥ 0.85) — all noul, **evidence-scoped** propositions ("judging only from the implementation description…") with polarity-aligned instructions; dimensions `dim_correctness/quality/tests/bmad` (score, 2–10 scale rendered as 9-level rubric, pass ≥ 5.0); `failure_kind` (choice: spec-misread / partial-implementation / regression / architecture-violation / test-gap / environment / none_applicable / other). Verdict `first_pass` only when all gates and dimensions pass; else `rework` + taxonomy.

## `router/memory.ts`

```python
retrieve_all(query, project_root=".") -> {"graft": str, "mem0": str, "mem0_active": bool}
format_context(ctx) -> str
```

Graft via local CLI (`graft ask --source`, ~1500 chars). Mem0 via platform REST when `MEM0_API_KEY` is set (top_k 8, min_score 0.65); otherwise returns a "not configured" note — degraded, never fatal.

## Lockfile schema (`router/thresholds.lockfile.json`)

```json
{
  "model_resolved": "typesafe/jev-1.13-20260917",
  "status": "candidate-final",
  "fitted": { "...": "per-gate sweeps with n and auto_acc" },
  "locked": { "intent_conf_min": 0.75, "safe_noul_escalate": 0.5,
               "safe_noul_clean": 0.75, "complexity_max": 1.5 },
  "gates": { "judge_gate_spec": 0.75, "judge_dim_min": 5.0,
              "readiness_spec_specific": 0.4, "...": "..." },
  "gates_meta": { "...": "fit accuracies and notes" }
}
```

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | jev_client, jev_adapter | TypeSafe direct (`https://api.typesafe.ai/v1/systemone`); preferred over OpenRouter when set |
| `OPENROUTER_API_KEY` | jev_client, jev_adapter, system2.ts | fallback Decisions path (`https://openrouter.ai/api/alpha/decisions`); absent both → clean skip |
| `MEM0_API_KEY` | memory.ts | enables the Mem0 retriever (optional) |
| `SYSTEM2_MODEL` | system2.ts | override the GLM model id |

Provider resolution (both keys set → TypeSafe direct wins): TypeSafe direct
**rejects** the dated snapshot ID — the client sends its alias (`jev-1.13.0`,
verified live: the dated ID returns HTTP 400 "Unknown model") and records the
logical pin on every response as `model_requested`; OpenRouter receives the
dated ID as-is. See D13 in `decisions.md`.

## Jev Decisions API contract (verified live)

Decisions endpoints (TypeSafe direct or OpenRouter fallback, see env vars) take `{model, state, questions}`. Every question needs `type` (`noul`|`choice`|`score`) + `instructions`. Per [docs.typesafe.ai/primitives/advanced](https://docs.typesafe.ai/primitives/advanced), `instructions`, `criteria` values (choice), level entries (score), and `criteria.true/false` (noul) all accept `string | object | array | null` — the project uses **structured objects wherever a boundary is subtle** (guardrails and readiness noul boundaries: `{what, examples}`; readiness score levels: `{summary, signals, examples}`; judge `failure_kind` options: `{what, not_for}`). Golden sets and runtime `QUESTIONS` are kept byte-identical (enforced by `evals/harness/tests/test_questions_golden_sync.ts`). Noul questions stay polarity-aligned (D10). Answers: noul → probability only (no confidence); choice → pick + probabilities + confidence; score → fractional score + legend + probabilities + confidence. Log the resolved model string every call: `model_requested` (the pin) + the response echo (`model` — provider-normalized; `ci_gate` warns when the echo is neither the pin nor its known alias).