"use client";

// app/dashboard/page.tsx
//
// v2 — replaces the v1 server-component version. Still the Kanban-style
// funnel board (counts + avg time-in-stage per column), but now each
// column can expand to show its individual leads, with an inline stage
// dropdown per lead. This is the "expand-to-individual-leads" future
// addition called out in the earlier plan.

import { useEffect, useState, useCallback } from "react";
import {
    Card,
    CardHeader,
    CardTitle,
    CardAction,
    CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type StageSummary = {
    stage: string;
    lead_count: number;
    avg_hours_in_stage: number | null;
};

type Lead = {
    id: string;
    name: string | null;
    email: string;
    channel: string | null;
    stage: string;
    message: string | null;
    created_at: string;
};

type RevenueStats = {
    totalRevenue: number;
    avgDealSize: number;
    closedWonCount: number;
    winRatePercent: number | null;
};

const STAGE_ORDER = [
    "new",
    "qualified",
    "opportunity",
    "closed_won",
    "closed_lost",
] as const;

// Stages that are outcomes rather than active pipeline states — tagged
// with a Badge so they read visually distinct from in-progress columns.
const TERMINAL_STAGES = new Set(["closed_won", "closed_lost"]);

// 'closed_won' -> 'Closed Won'
function formatStageName(stage: string): string {
    return stage
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function formatVelocity(avgHours: number | null): string {
    // null is expected for closed_won/closed_lost — they're terminal, so
    // there's no "time until next transition" to measure. Not missing data.
    if (avgHours === null) return "—";
    return `${avgHours.toFixed(1)}h avg`;
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatCurrency(amount: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
    }).format(amount);
}

function formatWinRate(percent: number | null): string {
    // null is expected when there are no closed deals yet at all (neither
    // won nor lost) — there's nothing to compute a rate from yet, not
    // missing data.
    if (percent === null) return "—";
    return `${percent}%`;
}

export default function DashboardPage() {
    const [summary, setSummary] = useState<StageSummary[] | null>(null);
    const [leads, setLeads] = useState<Lead[] | null>(null);
    const [revenue, setRevenue] = useState<RevenueStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [patchErrors, setPatchErrors] = useState<Record<string, string>>({});
    const [pendingLeadIds, setPendingLeadIds] = useState<Set<string>>(
        new Set(),
    );

    const loadData = useCallback(async () => {
        const [summaryRes, leadsRes, revenueRes] = await Promise.all([
            fetch("/api/dashboard/summary"),
            fetch("/api/leads"),
            fetch("/api/dashboard/revenue"),
        ]);

        if (!summaryRes.ok || !leadsRes.ok || !revenueRes.ok) {
            throw new Error("Failed to load dashboard data");
        }

        const summaryJson = await summaryRes.json();
        const leadsJson = await leadsRes.json();
        const revenueJson = await revenueRes.json();
        setSummary(summaryJson.summary);
        setLeads(leadsJson.leads);
        setRevenue(revenueJson);
    }, []);

    // `loading` starts true, so there's no separate setLoading(true) here —
    // this effect only needs to flip it off once the initial fetch settles.
    //
    // Data fetching on mount is one of React's own sanctioned Effect use
    // cases; the rule below flags it as if it were a render-loop
    // anti-pattern, but there's no framework-level fetching layer (e.g.
    // react-query, use()) in scope for this task to move it into instead.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadData()
            .catch((err) => {
                console.error(err);
                setLoadError("Failed to load dashboard data.");
            })
            .finally(() => setLoading(false));
    }, [loadData]);

    function toggleExpanded(stage: string) {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(stage)) {
                next.delete(stage);
            } else {
                next.add(stage);
            }
            return next;
        });
    }

    async function handleStageChange(leadId: string, newStage: string) {
        setPendingLeadIds((prev) => new Set(prev).add(leadId));
        setPatchErrors((prev) => {
            const next = { ...prev };
            delete next[leadId];
            return next;
        });

        try {
            const res = await fetch(`/api/leads/${leadId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ stage: newStage }),
            });

            if (!res.ok) {
                throw new Error(`Stage update failed (${res.status})`);
            }

            // Simple full refetch so counts, velocity, and column membership
            // all stay in sync — no optimistic UI/local patching.
            await loadData();
        } catch (err) {
            console.error(err);
            setPatchErrors((prev) => ({
                ...prev,
                [leadId]: "Failed to update stage. Please try again.",
            }));
        } finally {
            setPendingLeadIds((prev) => {
                const next = new Set(prev);
                next.delete(leadId);
                return next;
            });
        }
    }

    if (loading) {
        return (
            <div className="p-6">
                <p className="text-sm text-muted-foreground">
                    Loading dashboard…
                </p>
            </div>
        );
    }

    if (loadError || !summary || !leads || !revenue) {
        return (
            <div className="p-6">
                <p className="text-sm text-destructive">
                    {loadError ?? "Failed to load dashboard data."}
                </p>
            </div>
        );
    }

    // Group leads by stage client-side into the 5 STAGE_ORDER buckets.
    const leadsByStage = new Map<string, Lead[]>();
    for (const stage of STAGE_ORDER) leadsByStage.set(stage, []);
    for (const lead of leads) {
        leadsByStage.get(lead.stage)?.push(lead);
    }

    return (
        <div className="p-6">
            <h1 className="mb-4 text-xl font-semibold">Funnel</h1>

            {/* One column per stage, left to right in the order the API
          already returns (funnel order) — not re-sorted here. */}
            <div className="grid grid-cols-5 gap-4 items-start">
                {summary.map(({ stage, lead_count, avg_hours_in_stage }) => {
                    const stageLeads = leadsByStage.get(stage) ?? [];
                    const isExpanded = expanded.has(stage);

                    return (
                        <Card key={stage}>
                            <CardHeader>
                                <CardTitle>
                                    <button
                                        type="button"
                                        onClick={() => toggleExpanded(stage)}
                                        className="flex w-full items-center justify-between text-left"
                                    >
                                        {formatStageName(stage)}
                                        <span className="text-xs text-muted-foreground">
                                            {isExpanded ? "▲" : "▼"}
                                        </span>
                                    </button>
                                </CardTitle>
                                {TERMINAL_STAGES.has(stage) && (
                                    <CardAction>
                                        <Badge
                                            variant={
                                                stage === "closed_won"
                                                    ? "secondary"
                                                    : "destructive"
                                            }
                                            className={
                                                stage === "closed_won"
                                                    ? "border-transparent bg-green-600/10 text-green-700 dark:bg-green-500/20 dark:text-green-400"
                                                    : undefined
                                            }
                                        >
                                            {stage === "closed_won"
                                                ? "Won"
                                                : "Lost"}
                                        </Badge>
                                    </CardAction>
                                )}
                            </CardHeader>
                            <CardContent>
                                <div className="text-3xl font-semibold">
                                    {lead_count}
                                </div>
                                <div className="text-sm text-muted-foreground">
                                    {formatVelocity(avg_hours_in_stage)}
                                </div>

                                {isExpanded && (
                                    <ul className="mt-4 flex flex-col gap-3 border-t pt-3">
                                        {stageLeads.length === 0 && (
                                            <li className="text-xs text-muted-foreground">
                                                No leads in this stage.
                                            </li>
                                        )}
                                        {stageLeads.map((lead) => (
                                            <li
                                                key={lead.id}
                                                className="flex flex-col gap-1"
                                            >
                                                <div className="text-sm font-medium">
                                                    {lead.name ?? "Unnamed"}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {lead.email}
                                                </div>
                                                {lead.message && (
                                                    <div className="text-xs text-muted-foreground">
                                                        {truncate(
                                                            lead.message,
                                                            80,
                                                        )}
                                                    </div>
                                                )}
                                                <select
                                                    value={lead.stage}
                                                    disabled={pendingLeadIds.has(
                                                        lead.id,
                                                    )}
                                                    onChange={(e) =>
                                                        handleStageChange(
                                                            lead.id,
                                                            e.target.value,
                                                        )
                                                    }
                                                    className="mt-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                                                >
                                                    {STAGE_ORDER.map((s) => (
                                                        <option
                                                            key={s}
                                                            value={s}
                                                        >
                                                            {formatStageName(s)}
                                                        </option>
                                                    ))}
                                                </select>
                                                {patchErrors[lead.id] && (
                                                    <div className="text-xs text-destructive">
                                                        {patchErrors[lead.id]}
                                                    </div>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </CardContent>
                        </Card>
                    );
                })}
            </div>

            {/* Aggregate business metrics, not a funnel stage — kept
                visually distinct from the per-stage columns above via a
                single full-width card (bg tint, horizontal layout)
                instead of another grid tile. */}
            <Card className="mt-6 bg-muted/30">
                <CardHeader>
                    <CardTitle>Revenue</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap gap-8">
                        <div>
                            <div className="text-3xl font-semibold">
                                {formatCurrency(revenue.totalRevenue)}
                            </div>
                            <div className="text-sm text-muted-foreground">
                                Total closed revenue
                            </div>
                        </div>
                        <div>
                            <div className="text-3xl font-semibold">
                                {formatCurrency(revenue.avgDealSize)}
                            </div>
                            <div className="text-sm text-muted-foreground">
                                Avg deal size
                            </div>
                        </div>
                        <div>
                            <div className="text-3xl font-semibold">
                                {formatWinRate(revenue.winRatePercent)}
                            </div>
                            <div className="text-sm text-muted-foreground">
                                Win rate
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
