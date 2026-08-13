import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db/client';

// PATCH /api/leads/[id]
//
// Updates a single lead's stage. Delegates to the `update_lead_stage`
// Postgres function instead of running a separate UPDATE + INSERT here,
// because that function updates `leads.stage` and inserts into
// `stage_history` atomically in one transaction — doing it as two queries
// from the API route risks a partial write (e.g. the stage changes but
// the history log doesn't, or vice versa) if one query fails.

const STAGE_VALUES = [
  'new',
  'qualified',
  'opportunity',
  'closed_won',
  'closed_lost',
] as const;

type Stage = (typeof STAGE_VALUES)[number];

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
  const { data: existingLead, error: lookupError } = await supabase
    .from('leads')
    .select('id')
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

  return NextResponse.json({ ok: true, id, stage });
}
