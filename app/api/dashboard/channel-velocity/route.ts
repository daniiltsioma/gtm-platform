import { NextResponse } from "next/server";
import { supabase } from "@/lib/db/client";

// GET /api/dashboard/channel-velocity
//
// Queries the `funnel_velocity_by_channel` view (one row per
// channel+stage: { channel, stage, avg_hours_in_stage }) and reshapes it
// from that long format into wide format — one row per channel, with
// each non-terminal stage as its own key — which is the shape a stacked
// bar chart needs (one bar per channel, one stack segment per stage).
//
// The reshape happens here in JS rather than in SQL because it's just
// array restructuring (long -> wide), not aggregation — the actual
// aggregation (averaging hours-in-stage per channel+stage) already
// happened in the view itself.
//
// The view only has rows for 'new', 'qualified', 'opportunity' —
// closed_won/closed_lost are terminal stages with no "time until next
// transition" to measure, by the view's own design. That's expected,
// not missing data.

const CHART_STAGES = ["new", "qualified", "opportunity"] as const;

type ChannelVelocityRow = {
    channel: string;
    stage: string;
    avg_hours_in_stage: number;
};

export async function GET() {
    const { data, error } = await supabase
        .from("funnel_velocity_by_channel")
        .select("*");

    if (error) {
        console.error(
            "Dashboard channel-velocity: failed to query funnel_velocity_by_channel:",
            error,
        );
        return NextResponse.json(
            { error: "Failed to load channel velocity" },
            { status: 500 },
        );
    }

    const rows = data as ChannelVelocityRow[];

    // channel -> { stage: avg_hours_in_stage }
    const byChannel = new Map<string, Record<string, number>>();
    for (const row of rows) {
        if (!byChannel.has(row.channel)) {
            byChannel.set(row.channel, {});
        }
        byChannel.get(row.channel)![row.stage] = row.avg_hours_in_stage;
    }

    const wide = Array.from(byChannel.entries()).map(([channel, stages]) => {
        const result: Record<string, string | number> = { channel };
        for (const stage of CHART_STAGES) {
            // Default missing stage values to 0 (no completed transitions
            // yet for that channel+stage) rather than leaving them
            // undefined, so the chart doesn't break on a gap.
            result[stage] = stages[stage] ?? 0;
        }
        return result;
    });

    return NextResponse.json({ data: wide });
}
