// scripts/seed-hubspot-stage-progression.ts
//
// One-off dev tool — NOT application code. Run this AFTER
// scripts/seed-hubspot-contacts.ts has created contacts in HubSpot AND
// those contacts have been pulled into `leads` via the existing sync
// route (POST /api/integrations/hubspot/sync). This script advances a
// realistic distribution of those hubspot-sourced leads through stages,
// with backdated stage_history, so velocity data exists for them.
//
// Mirrors scripts/seed.ts's stage-distribution logic (STAGE_WEIGHTS /
// stagePathTo are copied below rather than imported — seed.ts is a
// self-running script, not an exported module: it unconditionally calls
// seed() at the bottom, so importing it here would immediately re-run
// its entire seed routine as a side effect). Keep these copies in sync
// manually if scripts/seed.ts's distribution ever changes.
//
// Deliberate difference from scripts/seed.ts: the gap between stage
// transitions here is roughly HALF of the website leads' range
// (2-48h vs. seed.ts's 4-96h). This is not an inconsistency — it's a
// modeling choice for the channel-comparison feature: HubSpot leads are
// actively worked/followed-up on by sales, unlike the passively inbound
// website leads, so their velocity should read faster on the dashboard.
//
// Two other differences from scripts/seed.ts: this operates on EXISTING
// lead rows (matched by channel = 'hubspot'), not new inserts, and it
// only updates leads still at stage 'new' (i.e. freshly synced, not yet
// progressed) so re-running this doesn't re-progress leads a second time.
//
// Run with: npx tsx scripts/seed-hubspot-stage-progression.ts

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const STAGE_ORDER = [
    "new",
    "qualified",
    "opportunity",
    "closed_won",
    "closed_lost",
] as const;
type Stage = (typeof STAGE_ORDER)[number];

// Copied from scripts/seed.ts's STAGE_WEIGHTS.
const STAGE_WEIGHTS: { stage: Stage; weight: number }[] = [
    { stage: "new", weight: 40 },
    { stage: "qualified", weight: 25 },
    { stage: "opportunity", weight: 15 },
    { stage: "closed_won", weight: 10 },
    { stage: "closed_lost", weight: 10 },
];

// Faster than scripts/seed.ts's 4-96h range — see file header comment.
const MIN_GAP_HOURS = 2;
const MAX_GAP_HOURS = 48;

function pickWeightedStage(): Stage {
    const total = STAGE_WEIGHTS.reduce((sum, s) => sum + s.weight, 0);
    let r = Math.random() * total;
    for (const { stage, weight } of STAGE_WEIGHTS) {
        if (r < weight) return stage;
        r -= weight;
    }
    return "new";
}

// Given a final stage, build the realistic sequence of stages a lead
// passed through to get there (e.g. 'opportunity' implies it passed
// through 'new' and 'qualified' first). Copied from scripts/seed.ts.
function stagePathTo(finalStage: Stage): Stage[] {
    const finalIndex = STAGE_ORDER.indexOf(finalStage);
    if (finalStage === "closed_lost") {
        // closed_lost can happen from any earlier stage, not just the end
        // of the happy path. Pick a random point to "die" at, then
        // transition to closed_lost from there.
        const dieAt = Math.floor(Math.random() * 3); // dies somewhere in new/qualified/opportunity
        return [...STAGE_ORDER.slice(0, dieAt + 1), "closed_lost"];
    }
    return STAGE_ORDER.slice(0, finalIndex + 1) as Stage[];
}

async function progressHubspotLeads() {
    // Dynamic import, deliberately not a static top-level import: this
    // script calls dotenv.config() above to load SUPABASE_URL /
    // SUPABASE_SERVICE_ROLE_KEY from .env.local, but lib/db/client.ts
    // reads those env vars at its own module-evaluation time. A static
    // `import { supabase } from "../lib/db/client"` at the top of this
    // file would be hoisted and evaluated before dotenv.config() runs,
    // capturing undefined env vars. Deferring the import until this
    // function actually runs (after dotenv.config() has executed)
    // avoids that ordering hazard.
    const { supabase } = await import("../lib/db/client");

    console.log("Fetching hubspot leads still at stage 'new'...");

    const { data: leads, error: fetchError } = await supabase
        .from("leads")
        .select("id, created_at")
        .eq("channel", "hubspot")
        .eq("stage", "new");

    if (fetchError) {
        console.error("Failed to fetch hubspot leads:", fetchError);
        process.exit(1);
    }

    if (!leads || leads.length === 0) {
        console.log("No hubspot leads at stage 'new' found. Nothing to do.");
        return;
    }

    console.log(`Found ${leads.length} leads to progress.`);

    let processed = 0;

    for (const lead of leads) {
        const finalStage = pickWeightedStage();
        const path = stagePathTo(finalStage);

        // Start the path from the lead's existing created_at, same as
        // scripts/seed.ts does for its new inserts.
        let cursor = new Date(lead.created_at);
        let fromStage: Stage | null = null;

        for (const stage of path) {
            // random gap between MIN_GAP_HOURS and MAX_GAP_HOURS per hop
            const gapMs =
                (MIN_GAP_HOURS +
                    Math.random() * (MAX_GAP_HOURS - MIN_GAP_HOURS)) *
                60 *
                60 *
                1000;
            cursor =
                fromStage === null ? cursor : new Date(cursor.getTime() + gapMs);

            const { error: historyError } = await supabase
                .from("stage_history")
                .insert({
                    lead_id: lead.id,
                    from_stage: fromStage,
                    to_stage: stage,
                    changed_at: cursor.toISOString(),
                });

            if (historyError) {
                console.error(
                    `Failed to insert stage_history for lead ${lead.id}:`,
                    historyError,
                );
            }

            fromStage = stage;
        }

        // Update the existing lead's stage (and updated_at) to match its
        // final stage — these are existing rows, not new inserts.
        const { error: updateError } = await supabase
            .from("leads")
            .update({ stage: finalStage, updated_at: cursor.toISOString() })
            .eq("id", lead.id);

        if (updateError) {
            console.error(`Failed to update lead ${lead.id}:`, updateError);
        }

        processed++;
        if (processed % 25 === 0) {
            console.log(`  ...${processed}/${leads.length} processed`);
        }
    }

    console.log(`Done. Progressed ${processed} hubspot leads.`);
}

progressHubspotLeads().catch((err) => {
    console.error("Stage progression script failed:", err);
    process.exit(1);
});
