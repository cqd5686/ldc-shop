import { checkAdmin } from "@/actions/admin"
import {
    authorizedInviteWorker, claimInviteJob, configureInviteJobs, deliverInvite, notifyManualInvites,
    sendInviteToManual, startInviteJob,
} from "@/lib/invite-jobs"

function reply(status: number, body: Record<string, unknown>) {
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request) {
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return reply(415, { error: "expected_json" })
    }
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== "object") return reply(400, { error: "invalid_request" })

    if (body.action === "configure") {
        const origin = request.headers.get("origin")
        const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL && new URL(process.env.NEXT_PUBLIC_APP_URL).origin
        if (!origin || (origin !== new URL(request.url).origin && origin !== configuredOrigin)) {
            return reply(403, { error: "origin_mismatch" })
        }
        try {
            await checkAdmin()
        } catch {
            return reply(401, { error: "unauthorized" })
        }
        if (typeof body.enabled !== "boolean" ||
            (body.token !== undefined && (typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)))) {
            return reply(400, { error: "invalid_configuration" })
        }
        await configureInviteJobs(body.enabled, body.token)
        return reply(200, { ok: true, enabled: body.enabled })
    }

    if (!(await authorizedInviteWorker(request))) return reply(401, { error: "unauthorized" })
    if (body.action === "status") return reply(200, { ok: true })
    if (body.action === "claim") return reply(200, { job: await claimInviteJob() })
    if (typeof body.orderId !== "string" ||
        typeof body.lease !== "string" || !/^[a-f0-9-]{36}$/.test(body.lease)) {
        return reply(400, { error: "missing_job" })
    }

    if (body.action === "start") {
        return await startInviteJob(body.orderId, body.lease)
            ? reply(200, { ok: true }) : reply(409, { error: "job_unavailable" })
    }
    if (body.action === "manual" && (body.reason === "unavailable" || body.reason === "uncertain")) {
        if (!(await sendInviteToManual(body.orderId, body.lease, body.reason))) {
            return reply(409, { error: "job_unavailable" })
        }
        await notifyManualInvites().catch(() => {})
        return reply(200, { ok: true })
    }
    if (body.action === "deliver" && typeof body.link === "string" && typeof body.expiresAt === "number") {
        const result = await deliverInvite(body.orderId, body.link, body.expiresAt, body.lease)
        if (result === "delivered") return reply(200, { ok: true })
        return reply(result === "invalid" ? 422 : 409, { error: result })
    }
    return reply(400, { error: "invalid_action" })
}
