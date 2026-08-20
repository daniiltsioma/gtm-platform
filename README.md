# GTM Lead Pipeline & Attribution Platform

A lead-to-revenue tracking system that answers a real GTM question: **does lead source actually affect how fast leads move through the pipeline — and if so, by how much, and what's it worth?**

Built to demonstrate the kind of work a growth/GTM engineer role actually requires: designing a data model for a funnel, integrating with real external tools (push, pull, and outbound), and turning raw event data into business answers — not just a CRUD app with a dashboard bolted on.

**Live demo:** https://gtm-platform-xi.vercel.app/ **Repo:** https://github.com/daniiltsioma/gtm-platform

---

## The problem

Most GTM tooling (HubSpot, a form tool, a CRM) shows you activity within that one tool. None of them can answer a question that spans sources: _"Do leads from HubSpot actually convert faster than organic website leads, or does it just feel that way — and how much revenue is each channel actually producing?"_

This project answers that with real (seeded) data: leads sourced from HubSpot move through the pipeline roughly **2x faster** than passive inbound website leads — a finding that lines up with a well-known GTM pattern (leads that get active follow-up convert faster than leads waiting in an inbox). That's the kind of insight a single tool's dashboard can't produce on its own, because it requires joining data across sources.

## What it does

- **Ingests leads from two structurally different integrations:**
    - A **push-based webhook** (Tally form submissions), with HMAC signature verification so the endpoint only accepts genuine, unmodified requests — not just anyone who finds the URL.
    - A **pull-based sync** (HubSpot's Contacts API), with full pagination handling and upsert-by-external-ID deduplication, so re-running the sync never creates duplicates or resets a lead's pipeline progress.
- **Sends outbound notifications** to Slack — a third, structurally different integration pattern (event-triggered, not ingest) — firing only when a lead reaches a genuinely meaningful stage (`opportunity`, `closed_won`, `closed_lost`), not on every minor change, to keep the channel useful instead of noisy.
- **Tracks every stage change as an immutable event**, not just current state — `stage_history` is append-only, which is what makes pipeline velocity computable at all.
- **Computes velocity and conversion rate per stage, split by channel**, using a Postgres window function to calculate time-in-stage directly in SQL, visualized as a stacked bar chart comparing channels head to head.
- **Tracks closed revenue and win rate** — total closed revenue, average deal size, and win rate, computed from actual deal outcomes.
- **Provides an interactive Kanban-style dashboard** — funnel counts, velocity, and revenue stats, with an expandable lead list and a stage-change action per lead, backed by an atomic Postgres function so a stage update and its history log can never fall out of sync.

## Architecture

```
Tally form ──webhook (signed)──┐
                                 ├──> Next.js API routes ──> Postgres (Supabase)
HubSpot CRM ──pull sync────────┘         │                    │
                                          │                    ├── leads (incl. deal_value)
                                          └──> Slack (outbound  ├── stage_history
                                               on key stages)   │
Next.js dashboard <──── SQL views (funnel_velocity, ───────────┘
  (Kanban + charts +      funnel_velocity_by_channel)
   revenue stats)
```

**Stack:** Next.js (App Router, TypeScript), PostgreSQL via Supabase, Vercel deployment, shadcn/ui, Recharts.

**Integration structure:** each third-party integration (Tally, HubSpot) has a dedicated module under `lib/integrations/` responsible only for understanding and trusting that specific service's protocol (signatures, pagination, payload shape). Business logic — what a "lead" is, how stages work, dedup rules — stays in the API routes, so integration code and domain logic never get tangled together.

## Key engineering decisions worth calling out

- **Stage transitions are unrestricted** (a lead can move `new → closed_won` directly, or move backward) — matches how real sales pipelines actually behave, rather than enforcing an idealized linear flow that would silently misrepresent reality.
- **The HubSpot sync preserves existing pipeline progress on re-sync** — it only touches `name`/`email`/`source`, never `stage`, on an existing record, so re-running the sync can never silently undo real pipeline work.
- **Dev and production run against fully separate Supabase projects** and separate Tally forms, after an early lesson in this build: sharing one database between local testing and the live deployment made it impossible to tell whether a curl test or a real user action was responsible for a change on the live dashboard.
- **Signature verification uses the raw request body**, not re-parsed JSON — HMAC verification is byte-exact, and re-serializing a parsed JSON object can silently change key order or whitespace, breaking verification in a way that's easy to miss in casual testing.
- **Slack notifications never affect the primary operation's outcome** — the integration module swallows its own errors and is awaited (not fire-and-forget) specifically because serverless functions can freeze execution the instant a response is sent, which would silently drop an un-awaited background call.

## Known limitations / deliberately out of scope

This project is intentionally scoped, not incomplete by accident.

- **No automated test suite yet.** Every route and edge case (signature rejection, invalid stage values, nonexistent lead IDs, dedup on re-sync, stage-preservation on re-sync) was tested manually and methodically during development, but that verification doesn't run itself or guard against future regressions. A small, targeted set of unit tests on the highest-risk logic (signature verification, the upsert/stage-preservation rule) is the natural next step, not a full suite for its own sake.
- **No authentication on the dashboard.** Row Level Security is intentionally not enabled yet — access is currently gated at the API route layer (server-side service role key only, never exposed to the browser). RLS is the correct next step once auth exists.
- **No account/opportunity layer.** The schema tracks individual leads through stages, but doesn't yet model accounts (a company with multiple contacts) or opportunities as separate entities — a deliberate scope decision to get the core funnel-tracking mechanics right first, rather than guessing at a data model for account-level rollups without a real use case driving it.
- **The HubSpot sync is manually triggered**, not scheduled or webhook-driven. A real production version would move to HubSpot's webhook subscriptions for real-time sync instead of on-demand pulls.
- **Deal value isn't editable from the dashboard UI** — it's currently set via seed data / would need to be set at the database level for real leads. UI editing is a small, well-scoped addition, deferred to keep this pass focused.
- **No data enrichment.** Deliberately not built — enriching a field a user was explicitly asked for and chose not to provide (e.g. a phone number) raises real consent questions that go beyond a portfolio project's scope to resolve responsibly. Enriching inferred, non-personal fields (e.g. company name from an email domain) would be a defensible next step; sourcing declined personal fields would not.

## Possible next steps

- A "needs attention" view — leads with no first response yet, or leads stalled significantly longer than the historical average for their stage/channel (the threshold would be a configurable business decision, not a hardcoded engineering guess)
- Speed-to-lead vs. final-outcome correlation analysis
- Duplicate/cross-channel lead matching (the same person entering via both the website and HubSpot)
- Additional integrations following the same push/pull/outbound patterns already established (Apollo, Clay, Go HighLevel)
