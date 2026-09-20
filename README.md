# model-wizard

model-wizard is an AI deployment agent that turns a Hugging Face model repository into a cost-conscious, validated RunPod service. It investigates the model, recommends suitable quantization and infrastructure, explains the options, and automates setup after explicit user approval — from artifact staging and image build through to a workload-validated endpoint and full lifecycle control (start, stop, update, rollback, destroy, cleanup).

The product ships as a **pi.dev extension + skill bundle** with a standalone **`mw`** command. Both interfaces share the same deployments, approvals, and state:

```bash
mw <name> <hf-repo>
```

## How it works

- **Agent**: pi.dev running GLM-5.3-flash via Ollama Cloud investigates the repository (README, metadata, exact artifact inventory), establishes workload requirements, and checks compatibility with SGLang, vLLM, and llama.cpp.
- **Jev decision primitives**: `choice` resolves configuration trade-offs, `score` evaluates scoped qualitative evidence, `noul` flags statements that warrant investigation.
- **Service skills** teach the agent to drive existing CLIs — `hf`, `runpodctl`, Wrangler (R2), Docker/Buildx — with documented SDK/API fallbacks.
- **Execution backend / supervisor** validates operations, enforces approvals, calculates resources and costs, tracks state in SQLite, and manages deadlines and cleanup. The agent can never approve its own spending or deletions.
- **Deployment path**: private Cloudflare R2 artifact staging → Dockerfile generation → image build and validation → publication to the user's Docker Hub → RunPod provisioning by verified digest → authenticated inference and workload validation, with explicit qualification levels (`Provisioned` → `Healthy` → `Smoke-tested` → `Workload-validated` → `Performance-qualified`).

When three distinct GPU allocations qualify, the user always sees at least three options — lowest cost, recommended balance, and a higher-capability upgrade — all meeting the same mandatory requirements, with the exact execution plan presented for approval before anything changes.

**Status:** Proposed product — the consolidated [product brief](docs/product-brief.md) and [implementation plan](docs/model-wizard-implementation-plan.md) are complete; implementation and integration validation are pending. The predecessor Jev-BMAD System-1/System-2 router work (phases 0–3, holdout-validated, `v0.1.0`) is retained in [`router/`](router/), [`evals/`](evals/), and [`jevBMAD-Documentation/`](jevBMAD-Documentation/).

## Installation

### Prerequisites

- **Python 3.11+** — runtime for the `mw` CLI and backend supervisor
- **Node.js + [pi.dev](https://pi.dev/)** — only needed for the in-Pi extension entry point
- **Service CLIs**, authenticated against your own accounts:
  - [`hf`](https://huggingface.co/docs/huggingface_hub/guides/cli) — Hugging Face Hub access (model inspection, artifact transfer)
  - [`runpodctl`](https://docs.runpod.io/runpodctl/overview) — RunPod Pods/Serverless management
  - [`wrangler`](https://developers.cloudflare.com/r2/reference/wrangler-commands/) — private Cloudflare R2 bucket configuration
  - **Docker + Buildx** — image build and Docker Hub publication
- **API credentials** (kept out of model-visible content by the backend):
  - `OPENROUTER_API_KEY` — Jev decision primitives
  - Ollama Cloud key — GLM-5.3-flash agent model

### Install `mw`

The `mw` CLI is not yet released. Once Phase 1 of the [implementation plan](docs/model-wizard-implementation-plan.md) lands, installation will be from source:

```bash
git clone https://github.com/peskycipher/model-wizard.git
cd model-wizard
pip install -e .          # installs the `mw` entry point
```

Install the pi extension and skills bundle alongside it for the in-Pi entry point — both attach to the same backend, state database, and approval store.

### Verify the environment

```bash
mw doctor                        # Pi/Node/extension versions, model access,
                                 # tool-call round trip, cancellation, output parsing
mw doctor --service runpod       # per-service auth + CLI contract probes
mw auth                          # credential status across services
```

`mw doctor` checks authenticated model access, a tool-call round trip, cancellation, and output parsing. If the supported installation cannot enforce the declared tool/path boundary, autonomous mutation preflight fails and the product stays in read-only planning mode.

### Try it

```bash
mw plan <name> <hf-repo>         # reviewable deployment plan only — no changes
mw <name> <hf-repo>              # full agent workflow: inspect → compare → approve → deploy → verify
mw status <name>                 # qualification level, endpoint, costs
mw verify <name>                 # run authorized validation gates
mw destroy <name>                # tear down (storage retained unless --purge-storage)
```

Planning commands are safe to run any time; every infrastructure mutation requires explicit approval of the exact execution plan.

## Documentation

| Path | What it is |
|---|---|
| [`docs/product-brief.md`](docs/product-brief.md) | Consolidated product brief: vision, UX, architecture, trust model, success measures |
| [`docs/model-wizard-implementation-plan.md`](docs/model-wizard-implementation-plan.md) | Implementation specification: command surface, records, workflows, phases, evaluation gates |
| [`jevBMAD-Documentation/`](jevBMAD-Documentation/) | Predecessor Jev-BMAD system: architecture, evaluation methodology, runbooks, decision log |
| [`router/`](router/) · [`evals/`](evals/) | Predecessor router code and golden-set evaluation harness |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution guidelines |

## License

See [`LICENSE`](LICENSE).