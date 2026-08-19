// lib/integrations/hubspot.ts
//
// Owns everything specific to authenticating with, paginating through,
// and understanding HubSpot's contact data shape. This module has no
// knowledge of our leads table, upsert logic, or stage-preservation
// rules — those are domain decisions that belong in the route handler,
// not in a module about HubSpot's API shape.

const HUBSPOT_CONTACTS_ENDPOINT =
    "https://api.hubapi.com/crm/v3/objects/contacts";

// Safety cap: stop pagination after this many pages so an unexpectedly
// large account (or a HubSpot API bug that never stops returning a
// `paging.next` cursor) can't spin this into an unbounded number of
// API calls.
const MAX_PAGES = 50;

export type RawHubspotContact = {
    id: string;
    properties: {
        firstname?: string | null;
        lastname?: string | null;
        email?: string | null;
    };
};

type HubspotContactsResponse = {
    results: RawHubspotContact[];
    paging?: {
        next?: {
            after?: string;
        };
    };
};

// Fetches every contact from HubSpot's Contacts API, following the
// `paging.next.after` cursor until HubSpot stops returning one — not
// capped at a fixed page/limit size. MAX_PAGES below is an unbounded-
// loop safety net only, not a real limit.
//
// Throws a plain Error (with HubSpot's response body included when
// available) on any API failure — this module doesn't know about HTTP
// status codes for a Next.js response, that translation is the route's
// job (it decides this becomes a 502).
export async function fetchAllHubspotContacts(
    accessToken: string,
): Promise<RawHubspotContact[]> {
    const contacts: RawHubspotContact[] = [];
    let after: string | undefined;
    let pageCount = 0;

    do {
        const url = new URL(HUBSPOT_CONTACTS_ENDPOINT);
        url.searchParams.set("properties", "firstname,lastname,email");
        if (after) url.searchParams.set("after", after);

        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(
                `HubSpot contacts fetch failed (${res.status}): ${body}`,
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

    return contacts;
}

export type ParsedHubspotContact = {
    external_id: string;
    name: string | null;
    email: string | null;
};

// Parses one raw HubSpot contact into our internal lead shape: combines
// firstname + lastname into a single `name`, maps HubSpot's contact id
// to `external_id`. Returns null if there's no email (same validation
// rule used elsewhere in this project) — the caller decides whether
// that counts as skipped.
export function parseHubspotContact(
    raw: RawHubspotContact,
): ParsedHubspotContact | null {
    const email = raw.properties.email;
    if (!email) return null;

    const name =
        [raw.properties.firstname, raw.properties.lastname]
            .filter(Boolean)
            .join(" ") || null;

    return {
        external_id: raw.id,
        name,
        email,
    };
}
