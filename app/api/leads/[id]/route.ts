import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db/client';
import { sendSlackNotification } from '@/lib/integrations/slack';

// PATCH /api/leads/[id]
//
// Updates a single lead's stage. Delegates to the `update_lead_stage`
// Postgres function instead of running a separate UPDATE + INSERT here,
// because that function updates `leads.stage` and inserts into
// `stage_history` atomically in one transaction — doing it as two queries
// from the API route risks a partial write (e.g. the stage changes but
// the history log doesn't, or vice versa) if one query fails.
//
// For a subset of "meaningful" stages (see NOTIFY_STAGES), also fires an
// outbound Slack notification after the update succeeds — this route's
// third integration pattern, after Tally's push webhook and HubSpot's
// pull sync: an outbound call triggered by an internal event. Slack
// delivery is best-effort and never affects this route's response —
// see lib/integrations/slack.ts.

const STAGE_VALUES = [
  'new',
  'qualified',
  'opportunity',
  'closed_won',
  'closed_lost',
] as const;

type Stage = (typeof STAGE_VALUES)[number];

// Only these stage transitions are worth a notification — 'new' and
// 'qualified' are too routine/high-volume to page a Slack channel for.
const NOTIFY_STAGES: Stage[] = ['opportunity', 'closed_won', 'closed_lost'];

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

// Builds the Slack message text for a notify-worthy stage change. Lives
// here, not in lib/integrations/slack.ts, since it's lead/stage domain
// logic — slack.ts only knows how to send a string, not what a lead or
// a stage is.
function buildStageChangeMessage(
  stage: Stage,
  lead: { name: string | null; email: string; deal_value: number | null },
): string {
  const name = lead.name ?? 'Unnamed';

  switch (stage) {
    case 'opportunity':
      return `🎯 Lead moved to Opportunity: ${name} (${lead.email})`;
    case 'closed_won': {
      // deal_value can come back as a string from Postgres numeric/decimal
      // columns over PostgREST, so coerce defensively.
      const value =
        lead.deal_value !== null
          ? ` — ${formatCurrency(Number(lead.deal_value))}`
          : '';
      return `✅ Deal closed WON: ${name} (${lead.email})${value}`;
    }
    case 'closed_lost':
      return `❌ Deal closed LOST: ${name} (${lead.email})`;
    default:
      // Unreachable given NOTIFY_STAGES, but keeps this function total.
      return `Lead stage changed to ${stage}: ${name} (${lead.email})`;
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || !UUID_REGEX.test(id)) {
    return NextResponse.json({ error: 'Invalid lead id' }, { status: 400 });
  }

  const body = await req.json();
  const stage = body.stage;

  if (!stage || !STAGE_VALUES.includes(stage)) {
    return NextResponse.json(
      {
        error: `Invalid stage. Must be one of: ${STAGE_VALUES.join(', ')}`,
      },
      { status: 400 }
    );
  }

  // Any transition is allowed, including skipping stages (e.g.
  // 'new' -> 'closed_won') — real pipelines don't always move
  // sequentially, so no ordering check here.

  // `update_lead_stage` doesn't give us a reliable signal for "no lead
  // matched that id" (it's not visible from this codebase whether it
  // returns void or a row count/exception on a no-op). Rather than guess
  // at that shape, check existence with a plain SELECT first, then let
  // the RPC do the actual atomic write. Small TOCTOU window between the
  // two calls is an acceptable tradeoff for this app's scale.
  //
  // Selecting name/email/deal_value here too (not just id) so the
  // post-update Slack notification below has what it needs without a
  // second round-trip — this route never changes those columns itself,
  // so reading them pre-update is still accurate post-update.
  const { data: existingLead, error: lookupError } = await supabase
    .from('leads')
    .select('id, name, email, deal_value')
    .eq('id', id)
    .maybeSingle();

  if (lookupError) {
    console.error('Failed to look up lead before stage update:', lookupError);
    return NextResponse.json(
      { error: 'Failed to update lead stage' },
      { status: 500 }
    );
  }

  if (!existingLead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
  }

  const { error: rpcError } = await supabase.rpc('update_lead_stage', {
    p_lead_id: id,
    p_new_stage: stage as Stage,
  });

  if (rpcError) {
    console.error('Failed to update lead stage:', rpcError);
    return NextResponse.json(
      { error: 'Failed to update lead stage' },
      { status: 500 }
    );
  }

  // The stage update has already succeeded at this point — everything
  // below is best-effort and must not change the response either way.
  // Awaited (rather than fire-and-forget) so the notification actually
  // gets a chance to complete before this serverless invocation ends,
  // per lib/integrations/slack.ts's contract: it never throws and its
  // return value is deliberately not checked here.
  if (NOTIFY_STAGES.includes(stage as Stage)) {
    await sendSlackNotification(
      buildStageChangeMessage(stage as Stage, existingLead),
    );
  }

  return NextResponse.json({ ok: true, id, stage });
}
