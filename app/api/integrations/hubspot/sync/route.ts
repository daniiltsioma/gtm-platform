import { NextResponse } from "next/server";
import { supabase } from "@/lib/db/client";

// POST /api/integrations/hubspot/sync
//
// Pull-based integration — contrast with the Tally webhook, which is
// push-based. This is triggered manually via API call for now, not on a
// schedule. It fetches contacts from HubSpot's CRM API and upserts them
// into `leads`, deduped by `external_id` (HubSpot's contact id).
//
// `stage` is intentionally preserved on re-sync, not reset to 'new', so
// re-running this doesn't undo pipeline progress a lead has made in our
// own funnel since it was first synced.
//
// Pagination is handled properly here (follows `paging.next.after` until
// HubSpot stops returning it), not capped at a fixed page/limit size —
// see MAX_PAGES below for the unbounded-loop safety net only.
//
// Future improvement: switch this from a manually-triggered pull to a
// HubSpot webhook-based push, for real-time sync instead of on-demand.

const HUBSPOT_CONTACTS_ENDPOINT =
    "https://api.hubapi.com/crm/v3/objects/contacts";

// Safety cap: stop pagination after this many pages so an unexpectedly
// large account (or a HubSpot API bug that never stops returning a
// `paging.next` cursor) can't spin this into an unbounded number of
// API calls.
const MAX_PAGES = 50;

type HubspotContact = {
    id: string;
    properties: {
        firstname?: string | null;
        lastname?: string | null;
        email?: string | null;
    };
};

type HubspotContactsResponse = {
    results: HubspotContact[];
    paging?: {
        next?: {
            after?: string;
        };
    };
};

export async function POST() {
    const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!hubspotToken) {
        return NextResponse.json(
            { error: "HUBSPOT_ACCESS_TOKEN is not configured" },
            { status: 500 },
        );
    }

    const contacts: HubspotContact[] = [];
    try {
        let after: string | undefined;
        let pageCount = 0;

        do {
            const url = new URL(HUBSPOT_CONTACTS_ENDPOINT);
            url.searchParams.set("properties", "firstname,lastname,email");
            if (after) url.searchParams.set("after", after);

            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${hubspotToken}` },
            });

            if (!res.ok) {
                const body = await res.text();
                console.error(
                    `HubSpot contacts fetch failed (${res.status}):`,
                    body,
                );
                return NextResponse.json(
                    { error: "Failed to fetch contacts from HubSpot" },
                    { status: 502 },
                );
            }

            const json: HubspotContactsResponse = await res.json();
            contacts.push(...(json.results ?? []));
            after = json.paging?.next?.after;
            pageCount++;

            if (after && pageCount >= MAX_PAGES) {
                console.warn(
                    `HubSpot contacts sync hit the ${MAX_PAGES}-page safety cap ` +
                        `(${contacts.length} contacts fetched so far); stopping early ` +
                        `even though more pages were available.`,
                );
                break;
            }
        } while (after);
    } catch (err) {
        console.error("HubSpot contacts fetch threw an error:", err);
        return NextResponse.json(
            { error: "Failed to fetch contacts from HubSpot" },
            { status: 502 },
        );
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const contact of contacts) {
        const email = contact.properties.email;
        if (!email) {
            skipped++;
            continue;
        }

        const name =
            [contact.properties.firstname, contact.properties.lastname]
                .filter(Boolean)
                .join(" ") || null;

        // Check-then-upsert instead of a single .upsert({ onConflict:
        // 'external_id' }) call: Supabase's upsert would SET every column
        // in the payload on conflict, and we specifically don't want to
        // touch `stage` on an existing lead (that would reset pipeline
        // progress on every re-sync). Fine for a low-frequency manual sync,
        // not a hot path — one extra SELECT per contact isn't a concern here.
        const { data: existingLead, error: lookupError } = await supabase
            .from("leads")
            .select("id,name,email")
            .eq("external_id", contact.id)
            .maybeSingle();

        if (lookupError) {
            console.error(
                `Failed to look up lead for HubSpot contact ${contact.id}:`,
                lookupError,
            );
            errors.push(
                `Lookup failed for contact ${contact.id}: ${lookupError.message}`,
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
                    `Failed to update lead for HubSpot contact ${contact.id}:`,
                    updateError,
                );
                errors.push(
                    `Update failed for contact ${contact.id}: ${updateError.message}`,
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
                external_id: contact.id,
                stage: "new",
            });

            if (insertError) {
                console.error(
                    `Failed to insert lead for HubSpot contact ${contact.id}:`,
                    insertError,
                );
                errors.push(
                    `Insert failed for contact ${contact.id}: ${insertError.message}`,
                );
                continue;
            }

            inserted++;
        }
    }

    return NextResponse.json({
        fetched: contacts.length,
        inserted,
        updated,
        skipped,
        errors,
    });
}
