// scripts/seed.ts
//
// Populates `leads` and `stage_history` with realistic fake data for
// dashboard development/testing. Bypasses the webhook entirely — inserts
// directly into Supabase using the service role key.
//
// Run with: npx tsx scripts/seed.ts
// (or: npm install -D tsx, then add "seed": "tsx scripts/seed.ts" to package.json scripts)

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { supabase } from "../lib/db/client";

// import { createClient } from "@supabase/supabase-js";

// const supabaseUrl = process.env.SUPABASE_URL!;
// const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ---- Config (sensible defaults, adjust as you like) ----
const NUM_LEADS = 200;
const CHANNELS = ["personal site", "linkedin post"]; // extend once you have more real channels
const DAYS_BACK = 30; // spread leads over the last 30 days

// Funnel stage order + a taper so most leads sit early in the funnel,
// like a real funnel — not evenly distributed.
const STAGE_ORDER = [
    "new",
    "qualified",
    "opportunity",
    "closed_won",
    "closed_lost",
] as const;
type Stage = (typeof STAGE_ORDER)[number];

// Weighted distribution of "how far did this lead get" — roughly funnel-shaped
const STAGE_WEIGHTS: { stage: Stage; weight: number }[] = [
    { stage: "new", weight: 40 },
    { stage: "qualified", weight: 25 },
    { stage: "opportunity", weight: 15 },
    { stage: "closed_won", weight: 10 },
    { stage: "closed_lost", weight: 10 },
];

const FIRST_NAMES = [
    "Alex",
    "Jordan",
    "Sam",
    "Taylor",
    "Morgan",
    "Casey",
    "Riley",
    "Jamie",
    "Drew",
    "Cameron",
];
const LAST_NAMES = [
    "Smith",
    "Johnson",
    "Lee",
    "Brown",
    "Garcia",
    "Miller",
    "Davis",
    "Wilson",
    "Clark",
    "Lewis",
];

function randomFrom<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickWeightedStage(): Stage {
    const total = STAGE_WEIGHTS.reduce((sum, s) => sum + s.weight, 0);
    let r = Math.random() * total;
    for (const { stage, weight } of STAGE_WEIGHTS) {
        if (r < weight) return stage;
        r -= weight;
    }
    return "new";
}

// Skewed toward the lower end (most deals are small, a few large) via
// the product of two uniform randoms, rather than pulling in a real
// statistical distribution library for a seed script. Range: $500-$15,000.
function generateDealValue(): number {
    return Math.round(500 + Math.random() * Math.random() * 14500);
}

function daysAgo(days: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d;
}

function randomDateWithin(daysBack: number): Date {
    const now = Date.now();
    const past = daysAgo(daysBack).getTime();
    return new Date(past + Math.random() * (now - past));
}

// Given a final stage, build the realistic sequence of stages a lead
// passed through to get there (e.g. 'opportunity' implies it passed
// through 'new' and 'qualified' first).
function stagePathTo(finalStage: Stage): Stage[] {
    const finalIndex = STAGE_ORDER.indexOf(finalStage);
    if (finalStage === "closed_lost") {
        // closed_lost can happen from any earlier stage, not just the end of the happy path.
        // Pick a random point to "die" at, then transition to closed_lost from there.
        const dieAt = Math.floor(Math.random() * 3); // dies somewhere in new/qualified/opportunity
        return [...STAGE_ORDER.slice(0, dieAt + 1), "closed_lost"];
    }
    return STAGE_ORDER.slice(0, finalIndex + 1) as Stage[];
}

async function seed() {
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

    console.log(`Seeding ${NUM_LEADS} leads...`);

    for (let i = 0; i < NUM_LEADS; i++) {
        const firstName = randomFrom(FIRST_NAMES);
        const lastName = randomFrom(LAST_NAMES);
        const name = `${firstName} ${lastName}`;
        const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`;
        const channel = randomFrom(CHANNELS);
        const finalStage = pickWeightedStage();
        const path = stagePathTo(finalStage);

        // Lead's creation time: somewhere in the last DAYS_BACK days
        const createdAt = randomDateWithin(DAYS_BACK);

        // Insert the lead itself, already at its final stage
        const { data: lead, error: leadError } = await supabase
            .from("leads")
            .insert({
                name,
                email,
                channel,
                stage: finalStage,
                // Only closed_won deals have a realized value — a lost
                // deal (or one still in progress) has none.
                deal_value:
                    finalStage === "closed_won" ? generateDealValue() : null,
                message:
                    Math.random() > 0.5
                        ? "Interested in learning more, please reach out."
                        : null,
                created_at: createdAt.toISOString(),
                updated_at: createdAt.toISOString(), // will bump below if there were transitions
            })
            .select()
            .single();

        if (leadError || !lead) {
            console.error(`Failed to insert lead ${i}:`, leadError);
            continue;
        }

        // Build stage_history: each hop happens some random hours/days after the last,
        // starting from createdAt, so velocity has real gaps to compute.
        let cursor = new Date(createdAt);
        let fromStage: Stage | null = null;

        for (const stage of path) {
            // random gap between 4 hours and 4 days per hop
            const gapMs = (4 + Math.random() * 92) * 60 * 60 * 1000;
            cursor =
                fromStage === null
                    ? cursor
                    : new Date(cursor.getTime() + gapMs);

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
                    `Failed to insert stage_history for lead ${i}:`,
                    historyError,
                );
            }

            fromStage = stage;
        }

        // Update the lead's updated_at to match its last real transition
        await supabase
            .from("leads")
            .update({ updated_at: cursor.toISOString() })
            .eq("id", lead.id);

        if ((i + 1) % 25 === 0)
            console.log(`  ...${i + 1}/${NUM_LEADS} inserted`);
    }

    console.log("Done seeding.");
}

seed().catch((err) => {
    console.error("Seed script failed:", err);
    process.exit(1);
});
