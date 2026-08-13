# CLAUDE.md

## Project

Mini lead-tracking / GTM analytics platform — portfolio project. Currently built: leads come in via Typeform webhook, get tracked through stages, shown on a dashboard. Account/opportunity layer and multi-source attribution are NOT designed yet — leads-only for now.

## Stack

- Frontend: Next.js (App Router), React, TypeScript
- Backend: Next.js API routes (no separate server)
- Database: PostgreSQL via Supabase
- Deploy: Vercel (app), Supabase (db)
- Integrations: Typeform (webhook). Nothing else yet — add here only once actually built.

## Commands

- `npm run dev` — local dev server
- `npm run build` — production build
- `npm run lint` — lint check before commits

## Architecture

- `/app/api/webhooks/` — inbound integration endpoints (Typeform)
- `/app/api/leads/` — CRUD + stage updates for leads
- `/app/api/dashboard/` — aggregated metrics for dashboard views
- `/app/dashboard/` — main dashboard views
- `/lib/db/` — database queries, schema types
- `/lib/integrations/` — per-integration client logic

## Data model

- `leads`: current state per lead (id, name, email, channel, stage, timestamps)
- `stage_history`: append-only log of stage transitions per lead — never overwritten, this is what makes pipeline velocity calculable later
- Stage values (enforced via check constraint): new, qualified, opportunity, closed_won, closed_lost
- Stage updates go through the `update_lead_stage` Postgres function (atomic: updates `leads` and inserts into `stage_history` in one transaction) — don't write these as two separate queries from the API route

## Security

- RLS is NOT enabled yet — deliberate, not an oversight. No auth exists on the dashboard yet, so access control is enforced at the API route layer instead:
    - API routes use the Supabase _service role key_ (server-side only, never sent to browser)
    - The frontend never talks to Supabase directly, only through `/app/api/` routes
- Revisit: enable RLS once auth is added, or if the frontend ever needs to query Supabase directly instead of going through API routes

## Workflow rules

- Webhook endpoints must verify signatures before processing
- Respond 200 to webhooks immediately; do slower work after the DB write, not before
- Never commit `.env`, `.env.local`, or the Supabase service role key — must be in `.gitignore`
- Run lint before considering a task done

## Boundaries

- Don't add new integrations without adding their client to `/lib/integrations/`
- Don't invent account/opportunity schema — that layer is intentionally undesigned until decided
