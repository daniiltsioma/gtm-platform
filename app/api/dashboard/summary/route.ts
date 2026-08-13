import { NextResponse } from 'next/server';
import { supabase } from '@/lib/db/client';

// GET /api/dashboard/summary
//
// Returns one row per funnel stage, combining two data sources:
//   - `leads`: current lead counts per stage (a live snapshot)
//   - `funnel_velocity` (Postgres view): avg hours spent in each stage,
//     computed from completed stage_history transitions
//
// These two sources are merged because `funnel_velocity` only covers
// stages that have an "exit" to measure time against — closed_won and
// closed_lost are terminal, so they never transition further and never
// appear in that view. Merging keeps the funnel response complete (every
// stage present) while making it explicit that terminal stages simply
// have no velocity figure.

const STAGE_ORDER = [
  'new',
  'qualified',
  'opportunity',
  'closed_won',
  'closed_lost',
] as const;

export async function GET() {
  const [leadsResult, velocityResult] = await Promise.all([
    supabase.from('leads').select('stage'),
    supabase.from('funnel_velocity').select('*'),
  ]);

  // Check both results before building anything — an error on either
  // query should fail the whole request, not silently produce a response
  // with one side missing/zeroed out.
  if (leadsResult.error) {
    console.error(
      'Dashboard summary: failed to query leads:',
      leadsResult.error
    );
    return NextResponse.json(
      { error: 'Failed to load dashboard summary' },
      { status: 500 }
    );
  }

  if (velocityResult.error) {
    console.error(
      'Dashboard summary: failed to query funnel_velocity:',
      velocityResult.error
    );
    return NextResponse.json(
      { error: 'Failed to load dashboard summary' },
      { status: 500 }
    );
  }

  // Count current leads per stage.
  const leadCounts = new Map<string, number>();
  for (const row of leadsResult.data) {
    leadCounts.set(row.stage, (leadCounts.get(row.stage) ?? 0) + 1);
  }

  // Map stage -> avg_hours_in_stage from the view. Stages absent here
  // (closed_won, closed_lost) are expected — they're terminal, so there's
  // no "next transition" to measure time until.
  const velocityByStage = new Map<string, number>(
    velocityResult.data.map((row) => [row.stage, row.avg_hours_in_stage])
  );

  const summary = STAGE_ORDER.map((stage) => ({
    stage,
    lead_count: leadCounts.get(stage) ?? 0,
    avg_hours_in_stage: velocityByStage.get(stage) ?? null,
  }));

  return NextResponse.json({ summary });
}
