// lib/integrations/tally.ts
//
// Owns everything specific to trusting and understanding Tally's webhook
// protocol: verifying a request actually came from Tally, and parsing a
// trusted payload into our internal lead shape. This module has no
// knowledge of our database — the route handler is responsible for
// deciding what to do with a successfully verified/parsed lead (insert,
// dedupe, etc).

import { createHmac, timingSafeEqual } from "node:crypto";

// Tally signs webhooks as base64(HMAC-SHA256(secret, rawBody)) in the
// `tally-signature` header. Verify against the RAW body string (not
// re-serialized JSON) — re-serializing can reorder keys or change
// whitespace and would break the signature.
//
// Returns false (never throws) for any missing header or malformed
// input — the caller decides what HTTP response to send, this function
// only answers yes/no.
export function verifyTallySignature(
    rawBody: string,
    signatureHeader: string | null,
    secret: string,
): boolean {
    if (!signatureHeader) return false;

    try {
        const expected = createHmac("sha256", secret).update(rawBody).digest();
        const provided = Buffer.from(signatureHeader, "base64");

        // timingSafeEqual throws on a length mismatch instead of
        // returning false, so guard for that first rather than letting
        // it throw.
        if (expected.length !== provided.length) return false;

        return timingSafeEqual(expected, provided);
    } catch {
        return false;
    }
}

export type ParsedTallyLead = {
    name: string | null;
    email: string;
    message: string | null;
};

// Parse a raw Tally webhook body — call this AFTER signature
// verification, using the same raw string. Returns null if no email
// field is found (same validation rule the route enforced before this
// logic moved here).
export function parseTallyLead(rawBody: string): ParsedTallyLead | null {
    const body = JSON.parse(rawBody);
    const fields = body.data.fields;

    const email = fields.find(
        (field: { type: string }) => field.type === "INPUT_EMAIL",
    )?.value;
    const name = fields.find(
        (field: { type: string }) => field.type === "INPUT_TEXT",
    )?.value;
    const message = fields.find(
        (field: { type: string }) => field.type === "TEXTAREA",
    )?.value;

    if (!email) return null;

    return {
        name: name ?? null,
        email,
        message: message ?? null,
    };
}
