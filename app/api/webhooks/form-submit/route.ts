import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db/client";
import { verifyTallySignature, parseTallyLead } from "@/lib/integrations/tally";

// POST /api/webhooks/form-submit
//
// Tally webhook handler. Signature verification is now enforced (see
// lib/integrations/tally.ts for the HMAC verification + payload parsing
// logic — that module owns Tally's protocol specifics; this route only
// decides what to do with a verified/parsed lead: insert into `leads`).

export async function POST(req: NextRequest) {
    const secret = process.env.TALLY_SIGNING_SECRET;
    if (!secret) {
        // Server misconfiguration, not a bad request — never fall back
        // to "unsigned is fine" just because the secret isn't set.
        console.error("TALLY_SIGNING_SECRET is not configured");
        return NextResponse.json(
            { error: "Server misconfiguration" },
            { status: 500 },
        );
    }

    // Raw text, not req.json() — signature verification needs the exact
    // raw bytes Tally signed, not a re-serialized/re-parsed version.
    const rawBody = await req.text();
    const signatureHeader = req.headers.get("tally-signature");

    if (!verifyTallySignature(rawBody, signatureHeader, secret)) {
        return NextResponse.json(
            { error: "Invalid signature" },
            { status: 401 },
        );
    }

    const lead = parseTallyLead(rawBody);

    if (!lead) {
        return NextResponse.json(
            { error: "No email found in form submission" },
            { status: 400 },
        );
    }

    const { error } = await supabase.from("leads").insert({
        name: lead.name,
        email: lead.email,
        message: lead.message,
        channel: "personal site",
        stage: "new",
    });

    if (error) {
        console.error("Failed to insert lead from Tally webhook:", error);
        return NextResponse.json(
            { error: "Failed to save lead" },
            { status: 500 },
        );
    }

    return NextResponse.json({ ok: true });
}
