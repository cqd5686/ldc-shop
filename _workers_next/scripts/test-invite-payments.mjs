import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"

const nativeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(
    readFileSync(new URL("../src/lib/invite-jobs.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

function fixture(t, notify = async () => ({ success: true })) {
    const sql = new DatabaseSync(":memory:")
    t.after(() => sql.close())
    sql.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE orders (
            order_id TEXT PRIMARY KEY, product_id TEXT, product_name TEXT, amount TEXT,
            email TEXT, user_id TEXT, username TEXT, status TEXT, points_used INTEGER,
            current_payment_id TEXT, quantity INTEGER, created_at INTEGER,
            paid_at INTEGER, trade_no TEXT
        );
        CREATE TABLE login_users (user_id TEXT PRIMARY KEY, username TEXT, points INTEGER);
        INSERT INTO login_users VALUES ('buyer-id', 'buyer', 100);
    `)
    function statement(query, values = []) {
        return {
            query, values,
            bind: (...params) => statement(query, params),
            async first() { return sql.prepare(query).get(...values) ?? null },
        }
    }
    const d1 = {
        prepare: statement,
        async batch(statements) {
            sql.exec("BEGIN IMMEDIATE")
            try {
                const results = statements.map(({ query, values }) => {
                    const results = sql.prepare(query).all(...values)
                    const { changes } = sql.prepare("SELECT changes() AS changes").get()
                    return { results, meta: { changes } }
                })
                sql.exec("COMMIT")
                return results
            } catch (error) {
                sql.exec("ROLLBACK")
                throw error
            }
        },
    }
    const afterTasks = []
    const receipts = []
    const notices = []
    const dependencies = {
        "@/lib/db": { getD1: async () => d1 },
        "@/lib/db/queries": {},
        "@opennextjs/cloudflare": {},
        "@/lib/notifications": {
            async notifyAdminPaymentSuccess(order) {
                receipts.push(order)
                return notify(order)
            },
        },
        "next/cache": {},
        "next/server": { after: (callback) => afterTasks.push(callback) },
    }
    const api = {}
    runInNewContext(source, {
        exports: api, Buffer, URL, process,
        console: { warn: (message) => notices.push(message), error: (message) => notices.push(message) },
        require: (id) => Object.hasOwn(dependencies, id) ? dependencies[id] : nativeRequire(id),
    })
    return {
        api, sql, receipts, notices, afterTasks,
        async finishRequest() {
            while (afterTasks.length) await afterTasks.shift()()
        },
    }
}

function order(orderId, amount, points = 0) {
    return {
        orderId, productId: "L_Invite", productName: "L站邀请码",
        userId: "buyer-id", username: "buyer", email: null, amount, points,
    }
}

test("a 1-credit payment sends one receipt, including concurrent duplicate confirmations", async (t) => {
    const f = fixture(t)
    await f.api.createInviteOrder(order("one-credit", 1))
    assert.equal(f.afterTasks.length, 0, "unpaid orders must not notify")
    const transitions = await Promise.all([
        f.api.queuePaidInvite("one-credit", "transaction-1"),
        f.api.queuePaidInvite("one-credit", "transaction-1"),
    ])
    assert.equal(transitions.filter(Boolean).length, 1)
    assert.equal(f.afterTasks.length, 1)
    assert.equal(f.receipts.length, 0, "the response must not wait for the notification")
    await f.finishRequest()
    assert.equal(f.receipts.length, 1)
    assert.equal(f.receipts[0].orderId, "one-credit")
    assert.equal(f.receipts[0].amount, "1.00")
    assert.equal(f.receipts[0].username, "buyer")
    assert.equal(f.receipts[0].tradeNo, "transaction-1")
    assert.equal(f.sql.prepare("SELECT state FROM invite_jobs WHERE order_id = ?").get("one-credit").state, "queued")
    assert.equal(await f.api.queuePaidInvite("one-credit", "transaction-1"), false)
    await f.finishRequest()
    assert.equal(f.receipts.length, 1)
})

test("points-only checkout sends a receipt after deduction and never sends a second one on callbacks", async (t) => {
    const f = fixture(t)
    await f.api.createInviteOrder(order("points-only", 0, 5))
    assert.equal(f.sql.prepare("SELECT points FROM login_users").get().points, 95)
    assert.equal(f.sql.prepare("SELECT status FROM orders").get().status, "paid")
    assert.equal(f.afterTasks.length, 1)
    await f.finishRequest()
    assert.equal(f.receipts.length, 1)
    assert.equal(f.receipts[0].amount, "5 (积分)")
    assert.equal(f.receipts[0].tradeNo, "POINTS_REDEMPTION")
    assert.equal(await f.api.queuePaidInvite("points-only", "duplicate"), false)
    await f.finishRequest()
    assert.equal(f.receipts.length, 1)
})

test("insufficient points and duplicate order insertion do not produce false receipts", async (t) => {
    const f = fixture(t)
    await assert.rejects(f.api.createInviteOrder(order("cannot-afford", 0, 101)), /insufficient_points/)
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM orders").get().n, 0)
    assert.equal(f.sql.prepare("SELECT points FROM login_users").get().points, 100)
    assert.equal(f.afterTasks.length, 0)
    await f.api.createInviteOrder(order("existing", 0, 10))
    await f.finishRequest()
    await assert.rejects(f.api.createInviteOrder(order("existing", 0, 10)))
    await f.finishRequest()
    assert.equal(f.sql.prepare("SELECT points FROM login_users").get().points, 90)
    assert.equal(f.receipts.length, 1)
})

test("notification failure does not undo a successful payment or stop fulfillment", async (t) => {
    const f = fixture(t, async () => { throw new Error("notification service unavailable") })
    await f.api.createInviteOrder(order("notification-error", 1))
    assert.equal(await f.api.queuePaidInvite("notification-error", "transaction-2"), true)
    await f.finishRequest()
    assert.equal(f.sql.prepare("SELECT status FROM orders").get().status, "paid")
    assert.equal(f.sql.prepare("SELECT state FROM invite_jobs").get().state, "queued")
    assert.equal(f.notices.length, 1)
})
