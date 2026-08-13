// app/dashboard/page.tsx
//
// v1 scope: renders the funnel as a Kanban-style board — one column per
// stage, showing lead counts and avg time-in-stage, sourced from
// GET /api/dashboard/summary. Expanding a column into its individual
// leads is a planned future addition, intentionally not built here.

import { headers } from 'next/headers';
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type StageSummary = {
  stage: string;
  lead_count: number;
  avg_hours_in_stage: number | null;
};

// Stages that are outcomes rather than active pipeline states — tagged
// with a Badge so they read visually distinct from in-progress columns.
const TERMINAL_STAGES = new Set(['closed_won', 'closed_lost']);

// 'closed_won' -> 'Closed Won'
function formatStageName(stage: string): string {
  return stage
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatVelocity(avgHours: number | null): string {
  // null is expected for closed_won/closed_lost — they're terminal, so
  // there's no "time until next transition" to measure. Not missing data.
  if (avgHours === null) return '—';
  return `${avgHours.toFixed(1)}h avg`;
}

async function getSummary(): Promise<StageSummary[]> {
  // Server Component calling our own API route needs an absolute URL;
  // build one from the incoming request's headers rather than hardcoding
  // a host.
  const headersList = await headers();
  const host = headersList.get('host');
  const protocol =
    headersList.get('x-forwarded-proto') ??
    (process.env.NODE_ENV === 'production' ? 'https' : 'http');

  const res = await fetch(`${protocol}://${host}/api/dashboard/summary`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to load dashboard summary (${res.status})`);
  }

  const { summary } = await res.json();
  return summary;
}

export default async function DashboardPage() {
  const summary = await getSummary();

  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Funnel</h1>

      {/* One column per stage, left to right in the order the API
          already returns (funnel order) — not re-sorted here. */}
      <div className="grid grid-cols-5 gap-4">
        {summary.map(({ stage, lead_count, avg_hours_in_stage }) => (
          <Card key={stage}>
            <CardHeader>
              <CardTitle>{formatStageName(stage)}</CardTitle>
              {TERMINAL_STAGES.has(stage) && (
                <CardAction>
                  <Badge
                    variant={stage === 'closed_won' ? 'secondary' : 'destructive'}
                    className={
                      stage === 'closed_won'
                        ? 'border-transparent bg-green-600/10 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                        : undefined
                    }
                  >
                    {stage === 'closed_won' ? 'Won' : 'Lost'}
                  </Badge>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold">{lead_count}</div>
              <div className="text-sm text-muted-foreground">
                {formatVelocity(avg_hours_in_stage)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
