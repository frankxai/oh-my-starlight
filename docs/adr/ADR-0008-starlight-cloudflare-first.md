# ADR-0008: Cloudflare-first execution for new Starlight missions

Status: proposed · 2026-10-31. A branch or pull request is not accepted policy.
Owner: Frank Riemer (`person_frank_riemer`).
Registry decision: `architecture_starlight_cloudflare_primary_runtime`.

## Context and authority

Frank's current instruction, paraphrased from the 31 October 2026 execution
session, is to make Cloudflare primary for the Starlight agent platform in light
of reported Cloudflare credits, with Vercel available as an optional adapter.
This records owner direction, not an observed credit balance, provider feature
entitlement, price advantage, production deployment or customer allowance.

Owner excerpt supplied in that session: "max out all we should use from
@Cloudflare and wire in we have credits there vercel we don't ... vercel nice
add ONS and harmonize and advanced build out now". The scoped decision below
interprets this as Cloudflare-first; neither provider's credit balance or terms
has been independently verified here.

The immediate product is a portable mission: a person starts a bounded team from
the web, phone or MCP client, sees its progress and evidence, reviews the exact
artifact, and receives an accountable outcome. Provider choice must support
that job without creating another scheduler, identity system or budget ledger.

Reviewed inputs:

- [Registry source 61114141e8c25c0891bef028fbfa38e8e1257742](https://github.com/frankxai/agentic-ops/blob/61114141e8c25c0891bef028fbfa38e8e1257742/registry/architecture_decisions.yaml).
- [Command projection 58335799e1b9a643e3e1a97533f433fc8058c389](https://github.com/frankxai/frankx-starlight-command/blob/58335799e1b9a643e3e1a97533f433fc8058c389/ARCHITECTURE-STACK.md).
  It cites Registry revision `149dd3c652edf6c3868e25ebd2dba8a69e0b70d1`;
  it is a projection, not a second authority.
- [Starlight runtime candidate 129937aeff9138ae005a40ee2b115e5467ab1d95](https://github.com/frankxai/starlightintelligence.ai/tree/129937aeff9138ae005a40ee2b115e5467ab1d95).
  Source implementation and app preview evidence do not qualify the hosted
  Worker, metered provider calls or production activation.

`registry/manifest.yaml` ranks current owner declarations above derived
proposals. `registry/AGENTS.md` still requires a reviewed Registry PR with
affected repositories, benefits, comparison, migration and rollback. The current
instruction permits preparation and scoped implementation; durable portfolio
policy takes effect through reviewed default-branch acceptance.

## Decision and exact scope

For **new Starlight hosted agent missions**, use the following default design
after acceptance and the workload gates below:

| Concern | Placement |
|---|---|
| Addressable mission actors and realtime state | Cloudflare Agents with SQLite Durable Objects |
| Actor-owned durable execution | Cloudflare Workflows, one durable orchestrator per mission |
| Native model execution | Workers AI when the selected model passes the task evaluation and accounting contract |
| Model routing | Direct Workers AI standard billing by default; optional Cloudflare AI Gateway or external adapters after explicit payer, pricing and entitlement verification |
| New mission artifact binaries | R2 is the first candidate; production adoption requires the named storage exception and evidence |
| Customer identity, tenancy, entitlements and credit reservation/settlement | Existing identity provider and Supabase/Postgres authority |
| Public site and current product web deployment | Preserve the existing Vercel deployment; moving hosting is a separate workload decision |
| Vercel model, deployment, sandbox and workflow services | Optional adapters for a named requirement; no mirrored mission orchestrator |

Keeping AI SDK integration code does not require Vercel-hosted inference.
Provider-neutral contracts, stable agent IDs, scoped operation tickets, MCP
schemas, evidence and approval records remain Starlight-owned. Stateless
inference does not acquire a Durable Object solely to fit the default.

Affected implementation owner: `repo_starlightintelligence_site`
(`frankxai/starlightintelligence.ai`). Related contract owner:
`repo_starlight_intelligence_system` (`frankxai/Starlight-Intelligence-System`).
Policy owner: `repo_agentic_ops`. Brand: `brand_starlight_intelligence`.
No new repository or independent shared-platform primitive is admitted.

## Relationship to accepted decisions

| Existing decision | Disposition |
|---|---|
| `architecture_experience_plane` | A scoped exception for new Starlight hosted execution and model routing; portfolio UI defaults and existing deployments remain intact |
| `architecture_persistent_entity_runtime` | Follow; it already selects Cloudflare for persistent actors |
| `architecture_durable_execution_boundary` | Follow; retain ownership and one orchestrator per workflow |
| `architecture_media_fabric_v2` | Preserve; R2 remains a candidate until a scoped mission-artifact exception is accepted |
| `architecture_agent_credentials_and_tools` | Preserve MCP, scoped grants and Infisical authority; no auth migration or new blanket connector grants |
| `architecture_observability_and_cost_contract` | Preserve attribution, bounded execution and cost per successful outcome |
| `architecture_portability_contract` | Preserve versioned domain contracts and replaceable provider adapters |

Do not mark a portfolio-wide decision superseded. The existing
`runtime_cost_model.yaml` routes and its checked documentation table stay
unchanged while this record is proposed. An accepted scoped routing row must
name this decision and update the exact table together. Production eligibility
remains a separate release gate even after policy acceptance.

## Why this direction, and what remains unproved

Cloudflare already owns the intended actor and durable workflow boundary.
Placing the qualified model route beside that execution may reduce operational
handoffs and can use eligible provider credits. These are expected benefits;
no measured saving, latency improvement or credit eligibility is asserted.

Compare the same bounded mission on the incumbent and candidate route. Record
accepted artifact quality, failure/recovery behavior, latency, developer
operability, credential exposure, data/residency fit and cost per accepted
outcome including failed attempts, embeddings and storage. Frank owns the
acceptance decision; implementation and independent verification remain
separate roles. A documented capability need can justify an optional adapter.

Cloudflare's [Workers bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
and [Agents AI SDK integration](https://developers.cloudflare.com/agents/models/ai-sdk/)
document native and external model routes. Compatibility with the product's
committed dependency versions still needs a real build and runtime check.

The [Unified Billing documentation](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
distinguishes request provider credentials, stored BYOK and prepaid-credit fallback.
The current [Startup Program FAQ](https://www.cloudflare.com/startups/) explicitly
excludes AI Gateway from startup credits and caps Workers AI by tier. Native
Workers AI standard billing is therefore the default candidate for eligible
credits; an external provider or Unified Billing route is an explicit separate
payer decision. There is no automatic fallback to a new payer. Workers AI has its own gateway billing setting. Therefore credit
coverage must be checked for the actual account, gateway, credential path and
model; promotional credits and prepaid inference credits are not assumed
interchangeable. Balance, eligible services, expiry and realized costs remain
unknown until verified. This ADR authorizes no credit purchase, auto-top-up,
plan change or higher customer spending ceiling.

## Implementation and release plan

1. **Policy and source reconciliation.** Review this ADR and the additive
   Registry record. Resolve acceptance in that PR and retain the current exact
   source pins. Reconcile the existing homepage/runtime candidates instead of
   starting a second runtime branch. Record a named implementation owner and
   verifier within the existing work-in-progress limits.
2. **One bounded Cloudflare model route.** Extend the current agent adapter and
   binding configuration behind the existing disabled activation gate. Pin the
   model, provider/credential path and rate version. Reuse current request-grant
   verification and transactional reservation authority. Snapshot routing for
   the mission; provider fallback must not silently change its authorized cost,
   data policy or effects.
3. **Metering before dispatch.** Prove per-call worst-case authorization,
   complete model and embedding usage, duplicate/concurrent request handling,
   missing-usage reconciliation and cancellation. Keep durable effect intent
   before the call. A timeout or lost result must not trigger another provider
   effect merely because the adapter or workflow retries. Gateway limits are
   defense in depth; they do not replace the customer ledger.
4. **Private artifact canary.** Propose a scoped R2 storage exception with an
   owner, lifecycle, deletion and recovery policy. Keep metadata, rights and
   approvals in the existing control plane. Test tenant isolation, immutable
   checksums, bounded upload/download, expired access, takedown and recovery.
   Prefer authenticated delivery for revocable access; [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
   confer bearer access until expiry and must not become approval authority.
   Do not copy existing assets or create competing canonical copies.
5. **Actual runtime qualification and release.** Run the committed Worker/SDK
   code under its real runtime, then one authorized private canary. Exercise
   start, reconnect, approval by the exact actor/artifact, interruption,
   uncertain outcomes, receipts and export on phone and desktop. Prove provider
   usage reconciliation and rollback before production promotion. A green app
   preview or source-only test suite does not satisfy this gate.

Stop if the route lacks current grant authority, a capped authorization,
compatible dependencies, privacy/rights evidence or observable usage. Do not
turn an unavailable model route into a silent alternative payer or retry.

## Migration and rollback

There is no bulk migration in this decision. Existing data, auth, ledger,
hosting, published assets and live tasks remain where they are. Apply new
routing only to newly admitted missions after qualification; never move or
replay an in-flight mission to another provider. Existing unknown effects keep
their durable reconciliation records and budget holds.

Rollback disables new admissions on the candidate route and restores the
previous configuration for new work only. Preserve run journals, immutable
artifacts and usage receipts; drain or reconcile accepted work. Revoke the new
route's credentials only after recovery requirements are satisfied. R2 rollout
must include a tested export/recovery path and a reference-safe deletion plan;
it must not require duplicating canonical metadata or deleting existing media.

## Rejected alternatives

- Treating credits or a beta announcement as permission to migrate every
  website, database, connector and asset. That changes unrelated owners and
  creates migration risk without outcome evidence.
- Keeping Vercel compulsory for all new Starlight model execution despite the
  current owner direction and Cloudflare actor ownership.
- Replacing the budget ledger with provider credits or gateway limits. Provider
  billing and customer authorization answer different questions.
- Importing a second factory scheduler or retrying unknown deployment/model
  effects. Reuse recipe and UI components through the current durable contract.

## Projection and acceptance receipt

After reviewed acceptance, refresh `docs/PORTFOLIO-PLATFORM-ARCHITECTURE.md`,
the scoped runtime routing projection, `STRATEGY.md` and relevant root-agent
guidance, then `frankx-starlight-command/ARCHITECTURE-STACK.md` and other loaded
projections. Each must record the **actual merged Registry SHA**. If root
`AGENTS.md` changes, run the repository's full rule synchronization and checks.
Do not insert a predicted merge SHA or call a proposal accepted.

This change's receipt must name exact source, changed files, independent review,
Registry/runtime-policy checks and the next gate. Acceptance of direction,
source implementation, deployment, measured spending and customer acceptance
are distinct states. No broad migration scope requires clarification to prepare
this narrow proposal; a future request to move existing web hosting or shared
data must name that workload and pass its own review.
