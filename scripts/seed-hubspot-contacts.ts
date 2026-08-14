// scripts/seed-hubspot-contacts.ts
//
// One-off dev tool — NOT application code. Generates ~100 fake contacts
// and creates them in HubSpot via the batch create API, so there's real
// data to pull in via the existing sync route
// (app/api/integrations/hubspot/sync).
//
// This script only needs to be run once to seed test data in HubSpot.
// Running it again will create MORE contacts, not update existing
// ones — HubSpot's batch create endpoint doesn't dedupe by email
// automatically unless a uniqueness rule is explicitly configured on
// that property.
//
// Run with: npx tsx scripts/seed-hubspot-contacts.ts

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const HUBSPOT_BATCH_CREATE_URL =
    "https://api.hubapi.com/crm/v3/objects/contacts/batch/create";

const NUM_CONTACTS = 100;
const CHUNK_SIZE = 10;
const CHUNK_DELAY_MS = 500;

// Deliberately a different name pool than scripts/seed.ts's fake leads,
// so hubspot-sourced contacts look visually distinct from website leads
// when eyeballing the leads table later.
const FIRST_NAMES = [
    "Avery",
    "Blake",
    "Charlie",
    "Dakota",
    "Elliot",
    "Finley",
    "Harper",
    "Indigo",
    "Jules",
    "Kai",
    "Logan",
    "Marlowe",
    "Nico",
    "Oakley",
    "Parker",
    "Quinn",
    "Reese",
    "Sage",
    "Tatum",
    "Wren",
];
const LAST_NAMES = [
    "Adler",
    "Bennett",
    "Chen",
    "Delgado",
    "Ellis",
    "Fischer",
    "Gallo",
    "Huang",
    "Ibarra",
    "Jensen",
    "Kessler",
    "Lindqvist",
    "Moreno",
    "Novak",
    "Ortiz",
    "Patel",
    "Quintero",
    "Reyes",
    "Silva",
    "Torres",
];

function randomFrom<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type FakeContact = {
    firstname: string;
    lastname: string;
    email: string;
};

function generateContacts(count: number): FakeContact[] {
    const contacts: FakeContact[] = [];
    for (let i = 0; i < count; i++) {
        const firstname = randomFrom(FIRST_NAMES);
        const lastname = randomFrom(LAST_NAMES);
        const email = `${firstname.toLowerCase()}.${lastname.toLowerCase()}${i}@example.com`;
        contacts.push({ firstname, lastname, email });
    }
    return contacts;
}

// HubSpot's batch create endpoint is all-or-nothing per call — if any
// single record in the batch fails (e.g. a duplicate email conflict),
// the whole call fails with a non-2xx status rather than partially
// succeeding. That's why the caller falls back to smaller chunks below:
// it isolates a bad record to a smaller blast radius instead of losing
// the entire run.
async function batchCreate(
    contacts: FakeContact[],
    token: string,
): Promise<{ created: number; error?: string }> {
    const res = await fetch(HUBSPOT_BATCH_CREATE_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            inputs: contacts.map((c) => ({ properties: c })),
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        return { created: 0, error: `(${res.status}) ${body}` };
    }

    const json = await res.json();
    return { created: json.results?.length ?? 0 };
}

async function seedHubspotContacts() {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) {
        console.error("HUBSPOT_ACCESS_TOKEN is not set. Aborting.");
        process.exit(1);
    }

    const contacts = generateContacts(NUM_CONTACTS);
    console.log(
        `Generated ${contacts.length} fake contacts. Creating in HubSpot...`,
    );

    let created = 0;
    const errors: string[] = [];

    // Try sending everything in one batch call first — HubSpot's batch
    // endpoint accepts up to 100 per call, which is exactly NUM_CONTACTS.
    const bulkResult = await batchCreate(contacts, token);

    if (!bulkResult.error) {
        created = bulkResult.created;
        console.log(`Created all ${created} contacts in a single batch call.`);
    } else {
        console.warn(
            `Single batch call failed, falling back to chunks of ${CHUNK_SIZE}:`,
            bulkResult.error,
        );

        for (let i = 0; i < contacts.length; i += CHUNK_SIZE) {
            const chunk = contacts.slice(i, i + CHUNK_SIZE);
            const chunkResult = await batchCreate(chunk, token);

            if (chunkResult.error) {
                // Duplicate email conflicts (and other per-chunk failures)
                // are treated as non-fatal here — log and move on to the
                // next chunk rather than aborting the whole seed run.
                console.error(
                    `Chunk starting at index ${i} failed:`,
                    chunkResult.error,
                );
                errors.push(`Chunk at index ${i}: ${chunkResult.error}`);
            } else {
                created += chunkResult.created;
                console.log(
                    `  ...chunk at index ${i}: created ${chunkResult.created}/${chunk.length}`,
                );
            }

            if (i + CHUNK_SIZE < contacts.length) {
                await sleep(CHUNK_DELAY_MS);
            }
        }
    }

    console.log("\nDone.");
    console.log(`  Attempted: ${contacts.length}`);
    console.log(`  Created:   ${created}`);
    console.log(`  Errors:    ${errors.length}`);
    if (errors.length > 0) {
        console.log("\nError details:");
        errors.forEach((e) => console.log(`  - ${e}`));
    }
}

seedHubspotContacts().catch((err) => {
    console.error("Seed script failed:", err);
    process.exit(1);
});
