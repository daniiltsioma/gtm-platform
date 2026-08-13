import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db/client";

// TODO: verify Tally webhook signature before processing (Tally-Signature
// header + signing secret). Deliberately deferred as a follow-up task — do
// not forward this endpoint's URL anywhere it could receive untrusted
// traffic until that's added.

export async function POST(req: NextRequest) {
    const body = await req.json();
    const fields = body.data.fields;

    console.log(fields);

    const email = fields.find(
        (field: { type: string }) => field.type === "INPUT_EMAIL",
    )?.value;
    const name = fields.find(
        (field: { type: string }) => field.type === "INPUT_TEXT",
    )?.value;
    const message = fields.find(
        (field: { type: string }) => field.type === "TEXTAREA",
    )?.value;

    if (!email) {
        return NextResponse.json(
            { error: "No email found in form submission" },
            { status: 400 },
        );
    }

    const { error } = await supabase.from("leads").insert({
        name,
        email,
        message,
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
