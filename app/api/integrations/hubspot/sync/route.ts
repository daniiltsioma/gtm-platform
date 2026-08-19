import { NextResponse } from "next/server";
import { supabase } from "@/lib/db/client";
import {
    fetchAllHubspotContacts,
    parseHubspotContact,
} from "@/lib/integrations/hubspot";

// POST /api/integrations/hubspot/sync
//
// Pull-based integration — contrast with the Tally webhook, which is
// push-based. Triggered manually via API call for now, not on a
// schedule. HubSpot-specific concerns — authenticating, paginating, and
// understanding HubSpot's contact data shape — live in
// lib/integrations/hubspot.ts. This route owns everything that's a
// decision about OUR data: matching HubSpot contacts to existing leads
// by `external_id`, and the upsert/dedup business logic.
//
// `stage` is intentionally preserved on re-sync, not reset to 'new', so
// re-running this doesn't undo pipeline progress a lead has made in our
// own funnel since it was first synced.
//
// Future improvement: switch this from a manually-triggered pull to a
// HubSpot webhook-based push, for real-time sync instead of on-demand.

export async function POST() {
    const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!hubspotToken) {
        return NextResponse.json(
            { error: "HUBSPOT_ACCESS_TOKEN is not configured" },
            { status: 500 },
        );
    }

    let rawContacts;
    try {
        rawContacts = await fetchAllHubspotContacts(hubspotToken);
    } catch (err) {
        console.error("Failed to fetch contacts from HubSpot:", err);
        return NextResponse.json(
            { error: "Failed to fetch contacts from HubSpot" },
            { status: 502 },
        );
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const raw of rawContacts) {
        const contact = parseHubspotContact(raw);
        if (!contact) {
            skipped++;
            continue;
        }

        const { external_id, name, email } = contact;

        // Check-then-upsert instead of a single .upsert({ onConflict:
        // 'external_id' }) call: Supabase's upsert would SET every column
        // in the payload on conflict, and we specifically don't want to
        // touch `stage` on an existing lead (that would reset pipeline
        // progress on every re-sync). Fine for a low-frequency manual sync,
        // not a hot path — one extra SELECT per contact isn't a concern here.
        const { data: existingLead, error: lookupError } = await supabase
            .from("leads")
            .select("id,name,email")
            .eq("external_id", external_id)
            .maybeSingle();

        if (lookupError) {
            console.error(
                `Failed to look up lead for HubSpot contact ${external_id}:`,
                lookupError,
            );
            errors.push(
                `Lookup failed for contact ${external_id}: ${lookupError.message}`,
            );
            continue;
        }

        if (existingLead) {
            const { error: updateError } = await supabase
                .from("leads")
                .update({ name, email, channel: "hubspot", source: "hubspot" })
                .eq("id", existingLead.id);

            if (updateError) {
                console.error(
                    `Failed to update lead for HubSpot contact ${external_id}:`,
                    updateError,
                );
                errors.push(
                    `Update failed for contact ${external_id}: ${updateError.message}`,
                );
                continue;
            }

            if (name != existingLead.name || email != existingLead.email) {
                updated++;
            }
        } else {
            const { error: insertError } = await supabase.from("leads").insert({
                name,
                email,
                channel: "hubspot",
                source: "hubspot",
                external_id,
                stage: "new",
            });

            if (insertError) {
                console.error(
                    `Failed to insert lead for HubSpot contact ${external_id}:`,
                    insertError,
                );
                errors.push(
                    `Insert failed for contact ${external_id}: ${insertError.message}`,
                );
                continue;
            }

            inserted++;
        }
    }

    return NextResponse.json({
        fetched: rawContacts.length,
        inserted,
        updated,
        skipped,
        errors,
    });
}
