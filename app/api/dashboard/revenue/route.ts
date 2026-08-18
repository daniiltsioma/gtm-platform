import { NextResponse } from "next/server";
import { supabase } from "@/lib/db/client";

// GET /api/dashboard/revenue
//
// Computes closed_won-only aggregates: total closed revenue, average
// deal size, closed_won count, and win rate. Intentionally separate from
// /api/dashboard/summary (which covers all stages) — revenue metrics
// only make sense for the closed_won subset of leads, and win rate needs
// the closed_lost count alongside it, neither of which fits summary's
// per-stage shape.

export async function GET() {
    const [closedWonResult, closedLostResult] = await Promise.all([
        supabase.from("leads").select("deal_value").eq("stage", "closed_won"),
        supabase
            .from("leads")
            .select("id", { count: "exact", head: true })
            .eq("stage", "closed_lost"),
    ]);

    if (closedWonResult.error) {
        console.error(
            "Dashboard revenue: failed to query closed_won leads:",
            closedWonResult.error,
        );
        return NextResponse.json(
            { error: "Failed to load revenue stats" },
            { status: 500 },
        );
    }

    if (closedLostResult.error) {
        console.error(
            "Dashboard revenue: failed to query closed_lost count:",
            closedLostResult.error,
        );
        return NextResponse.json(
            { error: "Failed to load revenue stats" },
            { status: 500 },
        );
    }

    const closedWonDeals = closedWonResult.data;
    const closedWonCount = closedWonDeals.length;
    const closedLostCount = closedLostResult.count ?? 0;

    // Number(...) guards against deal_value coming back as a string, which
    // Postgres numeric/decimal columns are returned as over PostgREST.
    const totalRevenue = closedWonDeals.reduce(
        (sum, lead) => sum + Number(lead.deal_value ?? 0),
        0,
    );

    // Zero closed_won deals -> 0s, not null or a division error.
    const avgDealSize = closedWonCount > 0 ? totalRevenue / closedWonCount : 0;

    // No closed deals of either kind yet -> null, not a divide-by-zero.
    const totalClosed = closedWonCount + closedLostCount;
    const winRatePercent =
        totalClosed > 0
            ? Math.round((closedWonCount / totalClosed) * 1000) / 10
            : null;

    return NextResponse.json({
        totalRevenue,
        avgDealSize,
        closedWonCount,
        winRatePercent,
    });
}
