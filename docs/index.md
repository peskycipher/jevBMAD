# Jev-BMAD Documentation

Reading order:

| File | Contents |
|---|---|
| [`architecture.md`](architecture.md) | Components, routing policy, memory layer, System-2 path, logging topology |
| [`evaluation.md`](evaluation.md) | Golden sets, metric definitions, splits, threshold fitting, audit pipeline, known biases |
| [`router-reference.md`](router-reference.md) | Module reference: signatures, return fields, lockfile keys, env vars, log schemas |
| [`bmad-integration.md`](bmad-integration.md) | The fork's wired decision points, advisory doctrine, how skills call them |
| [`operations.md`](operations.md) | Runbooks: evals, CI, sampling, prelabeling, dispute workflow, model-change re-fit |
| [`decisions.md`](decisions.md) | ADR-style log: every key decision with context and consequences |

Companion documents outside this folder:

- [`implementation.md`](implementation.md) — the original plan plus complete phase records, baselines, findings, and §14 known limitations (the authoritative history)
- [`../evals/README.md`](../evals/README.md) — harness usage: file formats, commands
- [`../README.md`](../README.md) — project overview and quickstart

Source material: [`breif.md`](breif.md) (the original product brief — Kahneman dual-process background) and [`prompt.md`](prompt.md) (the original prompt) that the project grew from.

Everything here describes the state as of **2026-09-19**, model `typesafe/jev-1.13-20260917`, unless noted otherwise. All metrics quoted are holdout-validated where the set size permits; where it does not (readiness, story_review), they are marked provisional.