# Video Assistant Chat + Agentic Capability Audit

## Context reviewed
- Agent loop stack: `Eyes -> Brain -> Hands -> Verifier`.
- UI chat panel and loop entry points.
- Gemini chat/planning/execution service layers.
- Timeline primitive definitions and execution surface.

---

## What currently blocks the “Cursor-like automation feel”

### 1) Architecture split-brain (multiple competing agent paths)
You currently have **two different execution architectures** in the repo:
1. `AgenticLoop + HandsAgent` (actively wired in App UI).
2. `OrchestratorAgent + ExecutorAgent` (appears unused).

That creates feature drift: each path supports slightly different behavior, defaults, and generation semantics. This is a major reason behavior feels inconsistent and “hardcoded.”

### 2) Brain planning is schema-driven text, not strict tool-call planning
`BrainAgent.plan()` asks for JSON and passes tool declarations, but does **not force function-calling mode** and then blindly `JSON.parse`s model text. This makes plan quality fragile and increases hallucinated operations/params risk.

### 3) Hands is intentionally limited and approval-gates all generation
`HandsAgent.execute()` intercepts generation operations and always pauses for approval, then exits loop. This is safe, but it dramatically reduces autonomous throughput.

### 4) Verifier fails open
When verification fails technically (API issues), it returns `passed: true`. This avoids lockups but hides bad states and falsely signals success.

### 5) Perception heuristics are coarse
Eyes chooses “survey mode” using `clips.length > 2`, which is a weak proxy for actual timeline complexity. It also does not persist a scene-level memory for later planning iterations.

### 6) Global state coupling
Loop receives `clips` input, but executes against global `timelineStore` snapshots internally. This can diverge from caller intent and makes reproducibility/testing harder.

### 7) Hardcoded defaults are spread everywhere
Model names, track IDs, duration presets, voice defaults, retry behavior, wait delays, and loop iterations are all inlined in multiple files. This makes capability expansion brittle.

### 8) Chat assistant is mostly a transcript shell
The assistant UI displays loop thoughts nicely, but there is no stronger state model for:
- plan lifecycle,
- tool execution receipts,
- confidence/uncertainty,
- long-running job handling,
- resume/retry policies.

### 9) Capability registry mismatch feeling
The “hands” agent feels familiar with only some features because support is encoded in `switch` branches plus hardcoded defaults. No discoverable runtime capability graph exists.

### 10) Repo has duplicate top-level app file patterns
Both `App.tsx` and `src/App.tsx` exist with overlapping logic, which increases maintenance confusion and can make feature updates land in the wrong file.

---

## Deep-dive suggestions (priority order)

## P0 — Unify runtime architecture
1. Pick one orchestrator path (recommended: keep `AgenticLoop`, retire or merge `OrchestratorAgent/ExecutorAgent`).
2. Create a single `ExecutionEngine` used by both chat and agent loop.
3. Eliminate duplicated operation handlers.

**Outcome:** no drift, less hardcoding, easier feature rollout.

## P0 — Introduce a capability registry
Create a typed runtime registry, e.g.:
- operation id,
- input schema,
- risk level,
- requires approval?
- estimated cost/latency,
- handler implementation,
- fallback strategy.

Then Brain plans against registry metadata and Hands executes from registry lookup (not hand-written switch-only behavior).

**Outcome:** hands “knows” all features consistently; easier to add Nano Banana/Veo/voice providers.

## P0 — Move policy from code to config
Externalize into one config layer:
- model routing policy (quality vs speed),
- approval thresholds,
- max iterations,
- default track mapping,
- retry/backoff,
- generation constraints.

**Outcome:** less hardcoded behavior, safer tuning without code edits.

## P1 — Make planning tool-native and deterministic
For `BrainAgent`:
- Use strict function-calling / constrained outputs for step generation.
- Validate each step against zod/json-schema before execution.
- Add a plan normalizer (fill missing params, coerce types, reject unknown operations).

**Outcome:** fewer invalid steps, better autonomous reliability.

## P1 — Strengthen verification semantics
- Change verifier from fail-open to tri-state: `pass | fail | unknown`.
- On `unknown`, trigger retry or user-visible warning.
- Add deterministic structural checks before model verifier (overlaps, gaps, orphan clips).

**Outcome:** safer autonomous edits and clearer trust boundaries.

## P1 — Add memory + execution receipts
Persist for each loop run:
- intent,
- analysis snapshot hash,
- chosen plan,
- per-step execution receipt,
- verifier result.

Use receipts in subsequent loops to avoid rework and improve explanations.

**Outcome:** Cursor-like continuity and debuggability.

## P2 — Better approval UX and policy engine
Instead of pausing for every generation step:
- auto-approve low-risk/low-cost ops,
- batch approvals for multi-step plans,
- require explicit approval for high-cost models or external uploads.

**Outcome:** faster flow while preserving user control.

## P2 — Capability expansion for “hands”
Add missing primitives likely needed for full editing autonomy:
- insert/replace transitions,
- auto-caption generation + style presets,
- beat-sync cuts,
- clip semantic search,
- b-roll suggestion/insertion,
- keyframe animation helpers,
- normalize loudness / ducking,
- auto-story arc sequencing.

**Outcome:** richer execution surface aligned with your product vision.

## P2 — Observability and eval harness
- Add telemetry spans per agent stage.
- Build a small benchmark suite of representative edit intents.
- Track success, cost, latency, and correction rate.

**Outcome:** measurable progress instead of anecdotal tuning.

---

## Suggested implementation blueprint (incremental)

### Phase 1 (1–2 days)
- Introduce `capabilityRegistry.ts`.
- Refactor Hands to execute via registry entries.
- Consolidate duplicate defaults into `agentPolicy.ts`.

### Phase 2 (2–4 days)
- Convert Brain outputs to strict validated step schema.
- Add deterministic pre-verifier checks.
- Add execution receipts persisted in store.

### Phase 3 (3–5 days)
- Merge/remove unused orchestrator stack.
- Implement approval policy engine + batching.
- Add telemetry + eval scripts.

---

## Practical “first 5 fixes” I would do immediately
1. Remove duplicate runtime paths (single source of truth execution engine).
2. Replace hardcoded switch defaults with capability registry + config.
3. Validate Brain plan steps before execution.
4. Change verifier fail-open behavior.
5. Add persistent receipts and expose them in chat UI.

These five changes alone should noticeably improve automation feel and reduce “hands only knows some features” behavior.
