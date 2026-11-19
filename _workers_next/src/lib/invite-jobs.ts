import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import type { D1Database } from "@cloudflare/workers-types"
import { getD1 } from "@/lib/db"
import { getSetting, setSetting, recalcProductAggregates, createUserNotification } from "@/lib/db/queries"
import { sendTelegramMessage } from "@/lib/notifications"
import { revalidatePath, revalidateTag } from "next/cache"

export const INVITE_PRODUCT_ID = "L_Invite"
const CONFIG_KEY = "invite_jobs_config"
const DAY_MS = 86_400_000
const LEASE_MS = 5 * 60_000
const REASONS = {
    unavailable: "四个账号均无法发码（冷却、登录失效或无可用额度）",
    uncertain: "发码结果未知，请先在 L 站核对",
}
type Reason = keyof typeof REASONS
type Job = {
    order_id: string
    state: string
    expires_at: number | null
    reason: Reason | null
    alert_after: number | null
}
type Config = { enabled: boolean, tokenHash: string }
type Order = {
    orderId: string, productId: string, productName: string, amount: number,
    email: string | null, userId: string, username: string | null, points: number,
}

let init: Promise<unknown> | undefined
async function inviteDb() {
    const d1 = await getD1() as D1Database
    init ??= d1.batch([
        d1.prepare(`CREATE TABLE IF NOT EXISTS invite_jobs (
            order_id TEXT PRIMARY KEY REFERENCES orders(order_id) ON DELETE CASCADE,
            state TEXT NOT NULL, queued_at INTEGER, lease TEXT, lease_until INTEGER,
            reason TEXT, alert_after INTEGER, expires_at INTEGER
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS invite_jobs_queue ON invite_jobs(state, queued_at)"),
    ]).catch((error) => {
        init = undefined
        throw error
    })
    await init
    return d1
}

async function config(): Promise<Config | null> {
    const value = await getSetting(CONFIG_KEY)
    return value ? JSON.parse(value) as Config : null
}

export async function activeInviteProduct() {
    return (await config())?.enabled ? INVITE_PRODUCT_ID : null
}

function tokenDigest(token: string) {
    return createHash("sha256").update(token).digest()
}

export async function configureInviteJobs(enabled: boolean, token?: string) {
    const existing = await config()
    const tokenHash = token ? tokenDigest(token).toString("hex") : existing?.tokenHash
    if (!tokenHash) throw new Error("Missing invite job token")
    await inviteDb()
    await setSetting(CONFIG_KEY, JSON.stringify({ enabled, tokenHash }))
    revalidatePath("/")
    revalidatePath("/search")
    revalidatePath(`/buy/${INVITE_PRODUCT_ID}`)
}

export async function authorizedInviteWorker(request: Request) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") || "")
    if (!match) return false
    const current = await config()
    return !!current && timingSafeEqual(tokenDigest(match[1]), Buffer.from(current.tokenHash, "hex"))
}

export async function getInviteJob(orderId: string, productId: string) {
    if (productId !== INVITE_PRODUCT_ID || !(await config())) return null
    const d1 = await inviteDb()
    return d1.prepare("SELECT order_id, state, expires_at, reason, alert_after FROM invite_jobs WHERE order_id = ?")
        .bind(orderId).first<Job>()
}

export async function createInviteOrder(order: Order) {
    const d1 = await inviteDb()
    const now = Date.now()
    const paid = order.amount === 0
    const insert = d1.prepare(`
        INSERT INTO orders (order_id, product_id, product_name, amount, email, user_id, username, status,
            points_used, current_payment_id, quantity, created_at, paid_at, trade_no)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
        WHERE ? = 0 OR changes() = 1
    `).bind(order.orderId, order.productId, order.productName, order.amount.toFixed(2), order.email,
        order.userId, order.username, paid ? "paid" : "pending", order.points, order.orderId, now,
        paid ? now : null, paid ? "POINTS_REDEMPTION" : null, order.points)
    const job = d1.prepare(`
        INSERT INTO invite_jobs (order_id, state, queued_at)
        SELECT ?, ?, ? WHERE changes() = 1
    `).bind(order.orderId, paid ? "queued" : "awaiting_payment", paid ? now : null)
    const debit = d1.prepare("UPDATE login_users SET points = points - ? WHERE user_id = ? AND points >= ?")
        .bind(order.points, order.userId, order.points)
    const results = await d1.batch(order.points > 0 ? [debit, insert, job] : [insert, job])
    if (results[results.length - 1].meta.changes !== 1) throw new Error("insufficient_points")
}

export async function queuePaidInvite(orderId: string, tradeNo: string) {
    const d1 = await inviteDb()
    const now = Date.now()
    const [payment] = await d1.batch([
        d1.prepare(`
            UPDATE orders SET status = 'paid', paid_at = ?, trade_no = ?
            WHERE order_id = ? AND status IN ('pending', 'cancelled')
              AND EXISTS (SELECT 1 FROM invite_jobs WHERE order_id = ? AND state = 'awaiting_payment')
        `).bind(now, tradeNo, orderId, orderId),
        d1.prepare(`
            UPDATE invite_jobs SET state = 'queued', queued_at = ?
            WHERE order_id = ? AND state = 'awaiting_payment' AND changes() = 1
        `).bind(now, orderId),
    ])
    return payment.meta.changes === 1
}

export async function claimInviteJob() {
    const d1 = await inviteDb()
    const now = Date.now()
    const lease = randomUUID()
    return d1.prepare(`
        UPDATE invite_jobs SET state = 'leased', lease = ?, lease_until = ?
        WHERE order_id = (
            SELECT j.order_id FROM invite_jobs j JOIN orders o ON o.order_id = j.order_id
            WHERE (j.state = 'queued' OR (j.state = 'leased' AND j.lease_until <= ?)) AND o.status = 'paid'
            ORDER BY j.queued_at, j.order_id LIMIT 1
        )
        RETURNING order_id AS orderId, lease
    `).bind(lease, now + LEASE_MS, now).first<{ orderId: string, lease: string }>()
}

export async function startInviteJob(orderId: string, lease: string) {
    const d1 = await inviteDb()
    const now = Date.now()
    const result = await d1.prepare(`
        UPDATE invite_jobs SET state = 'generating', lease_until = ?
        WHERE order_id = ? AND state IN ('leased', 'generating') AND lease = ? AND lease_until > ?
          AND EXISTS (SELECT 1 FROM orders WHERE order_id = ? AND status = 'paid')
    `).bind(now + LEASE_MS, orderId, lease, now, orderId).run()
    return result.meta.changes === 1
}

export async function sendInviteToManual(orderId: string, lease: string, reason: Reason) {
    const d1 = await inviteDb()
    const result = await d1.prepare(`
        UPDATE invite_jobs SET state = 'manual', lease = NULL, lease_until = NULL, reason = ?, alert_after = ?
        WHERE order_id = ? AND state IN ('leased', 'generating') AND lease = ?
          AND EXISTS (SELECT 1 FROM orders WHERE order_id = ? AND status = 'paid')
    `).bind(reason, Date.now(), orderId, lease, orderId).run()
    return result.meta.changes === 1
}

export async function deliverInvite(orderId: string, rawLink: string, expiresAt: number, lease?: string) {
    const link = rawLink.trim()
    const now = Date.now()
    if (!/^https:\/\/linux\.do\/invites\/[A-Za-z0-9_-]+(?:\?[^\s#]*)?$/.test(link) ||
        link.length > 1000 || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + DAY_MS) {
        return "invalid"
    }

    const d1 = await inviteDb()
    const claim = lease
        ? "(state = 'generating' OR (state = 'manual' AND reason = 'uncertain')) AND lease = ?"
        : "state = 'manual' AND ? IS NULL"
    const [updated] = await d1.batch([
        d1.prepare(`
            UPDATE orders SET status = 'delivered', card_key = ?, delivered_at = ?
            WHERE order_id = ? AND status = 'paid' AND card_key IS NULL
              AND EXISTS (SELECT 1 FROM invite_jobs WHERE order_id = ? AND ${claim})
              AND NOT EXISTS (SELECT 1 FROM orders WHERE product_id = ? AND card_key = ?)
            RETURNING user_id, product_id, product_name
        `).bind(link, now, orderId, orderId, lease ?? null, INVITE_PRODUCT_ID, link),
        d1.prepare(`
            UPDATE invite_jobs SET state = 'delivered', expires_at = ?, lease = NULL, lease_until = NULL, alert_after = NULL
            WHERE order_id = ? AND changes() = 1
        `).bind(expiresAt, orderId),
    ])
    const delivered = updated.results[0] as { user_id: string | null, product_id: string, product_name: string } | undefined
    if (!delivered) {
        const existing = await d1.prepare(`
            SELECT 1 AS done FROM orders o JOIN invite_jobs j ON j.order_id = o.order_id
            WHERE o.order_id = ? AND o.status = 'delivered' AND o.card_key = ? AND j.expires_at = ?
        `).bind(orderId, link, expiresAt).first()
        return existing ? "delivered" : "conflict"
    }

    revalidatePath(`/order/${orderId}`)
    revalidatePath(`/admin/orders/${orderId}`)
    revalidatePath("/orders")
    revalidatePath("/admin/orders")
    revalidateTag("home:products", "max")
    await recalcProductAggregates(delivered.product_id).catch(() => {})
    if (delivered.user_id) {
        await createUserNotification({
            userId: delivered.user_id,
            type: "order_delivered",
            titleKey: "profile.notifications.orderDeliveredTitle",
            contentKey: "profile.notifications.orderDeliveredBody",
            data: { params: { orderId, productName: delivered.product_name }, href: `/order/${orderId}` },
        }).catch(() => {})
    }
    return "delivered"
}

export async function notifyManualInvites() {
    if (!(await config())) return
    const d1 = await inviteDb()
    const now = Date.now()
    await d1.prepare(`
        UPDATE invite_jobs SET state = 'manual', reason = 'uncertain', lease_until = NULL, alert_after = ?
        WHERE state = 'generating' AND lease_until <= ?
          AND EXISTS (SELECT 1 FROM orders WHERE order_id = invite_jobs.order_id AND status = 'paid')
    `).bind(now, now).run()

    // Claim alerts for two minutes so concurrent cron ticks do not send the same message.
    const nextAttempt = now + 120_000
    const { results } = await d1.prepare(`
        UPDATE invite_jobs SET alert_after = ? WHERE order_id IN (
            SELECT j.order_id FROM invite_jobs j JOIN orders o ON o.order_id = j.order_id
            WHERE j.state = 'manual' AND j.alert_after <= ? AND o.status = 'paid'
            ORDER BY j.alert_after LIMIT 10
        ) RETURNING order_id, reason
    `).bind(nextAttempt, now).all<{ order_id: string, reason: Reason }>()
    const base = new URL(process.env.NEXT_PUBLIC_APP_URL || "https://shop.5881552.xyz")
    await Promise.all(results.map(async ({ order_id, reason }) => {
        const url = new URL(`/admin/orders/${encodeURIComponent(order_id)}`, base)
        const result = await sendTelegramMessage(`L 站邀请码订单待手动发货\n订单号 ${order_id}\n${REASONS[reason]}\n${url}`)
        if (result.success) {
            await d1.prepare("UPDATE invite_jobs SET alert_after = NULL WHERE order_id = ? AND alert_after = ?")
                .bind(order_id, nextAttempt).run()
        }
    }))
}
