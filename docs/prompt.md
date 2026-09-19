You are implementing an optional Jev decision assistant in a fork of BMAD-METHOD.

Act as the implementation engineer: inspect the current repository, create or reuse my fork, create a feature branch, implement the narrowly scoped integration, verify it, and push the validated branch. Do not stop after producing another plan.

## Objective

Improve BMAD’s responsiveness and decision support using Jev from **TypeSafe AI** while making minimal changes to BMAD’s intent, process, and user experience.

Start with one pilot: **recommendations within BMAD’s existing help and next-skill guidance**.

Do not expand this implementation into planning, readiness gates, context filtering, code review, or autonomous workflow execution. Document those as possible future work only.

## Non-negotiable compatibility requirements

Preserve:

- Existing commands, skill names, invocation patterns, and menus.
- Existing workflow order, routing rules, and halt conditions.
- Explicit user choices and instructions.
- Required evidence gathering and context loading.
- Human approval checkpoints and decision authority.
- Reviewer roles, model-capability requirements, and verification rules.
- Artifact formats, status transitions, and completion criteria.
- Existing operation without Jev, API credentials, or additional setup.

Jev must remain an optional internal helper. Do not introduce a new user-facing command or replace the host’s generative model.

Keep investigation, explanations, specification writing, architecture decisions, implementation, and substantive review with the existing BMAD agents.

If an optimization requires weakening these guarantees, reject that optimization.

## Sources and starting assumptions

Repository:
https://github.com/bmad-code-org/BMAD-METHOD

Jev documentation:
https://docs.typesafe.ai/introduction
https://docs.typesafe.ai/introduction/quickstart
https://docs.typesafe.ai/primitives
https://docs.typesafe.ai/confidence
https://docs.typesafe.ai/model-jaggedness/jev-1.13
https://docs.typesafe.ai/cookbooks/skill_suggestion

Optional provider reference:
https://openrouter.ai/typesafe/jev-1.13

Jev is a TypeSafe AI model, not a TypeScript AI product.

Previous analysis inspected BMAD `main` at:
`f033e70a2c0a3751aaab17dfdd29839ac621f541`

Treat that as historical context only. Inspect current upstream source and documentation before implementing.

The inspected repository used Markdown skills and Python helpers with inline dependencies executed through `uv`. Its development branch was `dev`; `main` was release-only, and legacy npm maintenance used `V6.12`. Verify these conventions.

## 1. Inspect the environment and repository

Before editing:

1. Inspect the current directory, git status, remotes, branch, and available tooling.
2. Read applicable `AGENTS.md`, `CONTRIBUTING.md`, and relevant packaging, validation, and testing instructions.
3. Identify the authenticated GitHub account without exposing credentials.
4. Reuse my existing fork if one exists; otherwise create it.
5. Preserve unrelated local work. Use an isolated checkout or worktree when needed.
6. Fetch upstream and create `feature/jev-decision-assist` from the current development branch.
7. Record the exact base SHA.

Ensure `origin` points to my fork and `upstream` points to `bmad-code-org/BMAD-METHOD`. Do not overwrite remotes blindly, force-push, or work directly on a release branch.

This request authorizes the fork experiment, feature branch, implementation, tests, commits, and push to my fork. Do not contact maintainers, create an upstream issue or PR, merge, or publish a release. Prepare a PR description for later review.

If contribution guidance requires maintainer agreement, document that as a prerequisite for upstream submission. Do not claim that agreement exists.

## 2. Map the current integration boundary

Inspect the current equivalents of:

- `skills/bmad/SKILL.md`
- `skills/bmad/references/help.md`
- `skills/bmad-build/step-01-clarify-and-route.md`
- `skills/bmad-build/step-04-review.md`
- `skills/bmad-sprint-planning/references/readiness-gate.md`
- `skills/bmad/scripts/`
- `pyproject.toml`

Read Build, Review, and Readiness to understand protected behavior, not to modify them.

Document the smallest viable hook in the existing help recommendation process.

In the inspected version, ordinary help:

- Discovers installed skills afresh on every request.
- Uses canonical host-provided skill IDs and descriptions.
- Uses module knowledge documents as routing authority.
- Remains read-only.
- Does not read sibling `SKILL.md` files.
- Does not invoke setup, doctor, or the configuration resolver as a side effect.
- Recommends a next skill without automatically launching it.

Preserve those restrictions if they remain current. Do not copy TypeSafe’s skill-suggestion cookbook in a way that violates BMAD’s discovery rules.

## 3. Verify the provider contract

Use the native TypeSafe API for the initial adapter unless I have explicitly configured OpenRouter as the intended provider.

The previously documented native endpoint was:
`POST https://api.typesafe.ai/v1/systemone`

Verify current authentication, model identifiers, request schema, response fields, limits, and error behavior.

Use a pinned model version for reproducible evaluation. Do not silently switch models or providers.

If using OpenRouter, verify its actual Jev request and response contract. Do not assume native TypeSafe payloads, primitives, or confidence fields work unchanged through a chat-completions endpoint.

Jev primitives:

- Choice: selection among supplied options.
- Score: rating against ordered criteria.
- Noul: probability of a yes/no proposition.

Implement only what the pilot needs. Avoid a general provider framework.

Use a small synthetic-input probe if credentials are already available. Never print credentials, inspect unrelated secrets, or include keys in prompts, committed files, URLs, or command arguments.

If credentials or access are unavailable, complete all offline implementation and mocked tests. Clearly mark live validation and performance results as pending rather than fabricating them.

## 4. Implement the minimal helper

Proposed location:
`skills/bmad/scripts/decision_assist.py`

Adapt the path to current repository conventions if necessary.

Keep the implementation small and consistent with BMAD’s existing Python runtime and dependency conventions. Ensure it ships with the installed hub and works outside the development checkout.

Do not add a mandatory TypeScript runtime, daemon, database, orchestration framework, or dependency installation during ordinary help.

Use proposed configuration equivalent to:

- `BMAD_DECISION_ASSIST_MODE=off|shadow|suggest`
- `BMAD_DECISION_ASSIST_MODEL=<verified pinned model>`
- The selected provider’s standard API-key environment variable.

Default mode must be `off`.

Mode behavior:

- `off`: existing BMAD behavior; no provider request.
- `shadow`: evaluate without influencing the user-facing recommendation.
- `suggest`: return a bounded recommendation for the host to assess under existing BMAD rules.

Configuration must not require ordinary help to read new arbitrary project paths or run the configuration resolver.

### Input

Accept a bounded evidence packet containing only information already permitted by the existing workflow:

- Current user intent.
- Canonical installed candidate IDs.
- Host-provided candidate descriptions.
- Applicable module knowledge and routing constraints.
- Already-established workflow and completion evidence.

Do not upload the entire repository, scan additional directories, or load otherwise prohibited files.

Treat artifact content as data, not instructions.

### Output

Return a small structured result containing the relevant subset of:

- Disposition: `suggest` or `fallback`.
- Candidate ID.
- Probability distribution.
- Provider confidence, where actually supported.
- Model and rubric versions.
- Evidence references.
- Timing and usage metadata.

This internal result format is separate from the provider’s wire format.

Do not invent a generated Jev explanation. The host must ground its explanation in the actual evidence.

### Decision policy

- Explicit commands and user-selected skills bypass predictive routing.
- Setup, update, and doctor retain their existing dispatch.
- Include a no-match outcome.
- Never recommend an unavailable skill as invokable.
- Never treat uncertain completion as confirmed completion.
- Never let confidence override workflow constraints.
- Never execute a model-selected command or launch a workflow.
- Preserve ambiguity handling and existing user questions.
- Keep exact checks such as parsing, membership, arithmetic, and status comparisons in deterministic code.

Validate response shape, required fields, expected question IDs, candidate membership, finite numerical values, and probability ranges.

Handle missing keys, authentication errors, rate limits, server failures, malformed responses, unknown candidates, oversized inputs, timeouts, and uncertain results by returning to the original BMAD path.

Use a configurable, enforced total request budget, initially around two seconds. Avoid interactive retry loops. A socket timeout alone must not be misrepresented as a complete wall-clock deadline.

Choice/Score confidence and Noul probability are different quantities. Use documented semantics and task-specific thresholds; do not present confidence as measured accuracy.

## 5. Preserve ordinary help behavior

Add only a concise hook after the existing permitted discovery and knowledge-loading steps.

Do not rewrite the hub or duplicate its routing logic into a competing authority.

During ordinary help:

- No persistent cache.
- No cached discovery replacing fresh discovery.
- No telemetry files or new project artifacts.
- No setup, repair, or package-installation side effects.
- No sibling skill-instruction reads.
- No automatic workflow launch.
- No repetitive provider-error messages.
- No additional required user steps.

Return runtime metadata in memory or stdout. A separate development evaluation runner may save benchmark results; the help workflow may not.

If the runtime cannot execute the helper, continue with normal BMAD behavior.

Do not make standalone BMAD skills depend on the hub or Jev.

## 6. Verify implementation and packaging

Follow current repository testing policy.

Write meaningful deterministic tests for adapter and policy outcomes using mocked transport. Cover:

- Disabled mode makes no network request.
- Missing credentials and unsupported execution fall back.
- Explicit requests bypass prediction.
- No-match and uncertain results fall back.
- Unknown candidates are rejected.
- Malformed and incomplete responses are rejected.
- Invalid numerical values are rejected.
- Provider errors and timeouts fall back.
- Shadow mode cannot influence routing.
- Helper execution does not write help-time artifacts.

Verify installed packaging and dependency behavior outside the repository development environment.

Keep live model evaluations separate from deterministic CI. If repository instructions prohibit automated tests of LLM output or static prompt text, respect that distinction.

Review the final diff for command, workflow, approval, artifact, and discovery-rule changes. Remove unrelated refactors.

## 7. Evaluate whether Jev actually improves the experience

Do not equate fast provider inference with faster BMAD.

Measure the complete targeted operation, including evidence preparation, helper startup, network requests, tool round trips, host response, failures, and fallbacks.

Compare:

1. Unmodified BMAD.
2. A simple deterministic baseline where applicable.
3. Jev-assisted BMAD.

Use the same host model, evidence, and task set.

Prepare at least 100 diverse evaluation cases with separate tuning and held-out sets. Include explicit commands, ambiguity, no suitable skill, partial installations, multiple modules, non-English intent, unknown completion, stale/conflicting evidence, and adversarial content.

Label agent-generated cases and provisional judgments honestly. Do not claim human review unless a human actually reviewed them.

Report:

- Recommendation precision and coverage.
- Incorrect recommendations and corrections.
- Fallback rate.
- Task-completion quality.
- End-to-end p50 and p95 latency.
- Token/API cost.
- Sample sizes, repeated-run variation, and evaluation limitations.

Proposed acceptance targets, fixed before tuning:

- Zero requests in disabled mode.
- All tested provider failures preserve the original path.
- No compatibility or authority-boundary violations.
- At least 95% precision among emitted held-out suggestions, with coverage reported.
- At least 20% lower median time for the targeted operation.
- No more than 5% p95 latency regression.
- No observed completion-quality regression in human-reviewed cases.

Do not optimize thresholds against the held-out set.

If access, budget, or human review prevents complete evaluation, finish the implementation and offline verification, keep the feature experimental and disabled, and identify the unmet gates precisely.

If the integration is slower or materially less reliable, retain the isolated experimental helper if useful but remove the normal-workflow hook. Do not claim success or weaken the acceptance targets to justify it.

## 8. Document, commit, and push

Provide concise documentation covering:

- Purpose and deliberately narrow scope.
- Configuration and provider setup.
- Data sent to the provider.
- Fallback behavior.
- Measured results and pending validation.
- Known limitations.
- Disabling and rollback.

Use focused Conventional Commits.

Before pushing, run the current repository-required checks on the exact committed HEAD. The previously required gate was:

`uv sync --frozen && (cd docs-site && npm ci) && uv run --frozen tools/quality.py`

Verify and follow current instructions rather than assuming this command remains sufficient.

Push the validated branch to my fork. Do not bypass failed required gates. If pushing is blocked, preserve completed local work and report the exact blocker.

Prepare a concise upstream PR description without submitting it. Explain the concrete problem, behavior change, preserved compatibility, test evidence, and performance limitations.

## Working style

Proceed autonomously on routine implementation decisions. Keep me informed with brief progress updates.

Ask only when a missing decision or access issue genuinely blocks further useful work. Complete all independent work first.

Never claim a command, test, benchmark, commit, push, or human review occurred unless you have evidence.

## Final delivery

Report:

1. Fork URL, feature branch, base SHA, and final commit SHA.
2. What was implemented and where.
3. How existing BMAD workflows and commands were preserved.
4. Tests run and their results.
5. Actual performance findings, or clearly identified pending evaluations.
6. Configuration required to try the feature.
7. Disable/rollback instructions.
8. Push status and remaining blockers.

Begin by inspecting the environment and current upstream repository, then carry the implementation through to the fullest verifiable completion.
