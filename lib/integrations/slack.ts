// lib/integrations/slack.ts
//
// Thin wrapper around Slack's Incoming Webhook API. Has no knowledge of
// leads, stages, or any other domain concept — callers build the message
// text; this module only knows how to send it.
//
// Deliberately swallows its own errors (missing config, network failure,
// non-2xx response) instead of throwing. Slack notifications are a
// "nice to have" side effect here, not a critical path — a failed or
// unconfigured notification should never fail or roll back the
// operation it's attached to.

export async function sendSlackNotification(message: string): Promise<boolean> {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;

    if (!webhookUrl) {
        console.warn(
            "SLACK_WEBHOOK_URL is not configured — skipping Slack notification.",
        );
        return false;
    }

    try {
        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: message }),
        });

        if (!res.ok) {
            const body = await res.text();
            console.error(
                `Slack notification failed (${res.status}):`,
                body,
            );
            return false;
        }

        return true;
    } catch (err) {
        console.error("Slack notification threw an error:", err);
        return false;
    }
}
