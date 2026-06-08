import {
    chainLiquidityIncremented,
    payoutDispatched,
    withdrawalAuthorized,
    withdrawalCompleted,
    withdrawalFailed,
    withdrawalRequested,
} from "../../src/processors/withdrawal-registry.processor.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { makeHubChain } from "../helpers/chain.js";
import {
    FakePoolClient,
    asPoolClient,
    stageAlreadyStamped,
    stageNotYetStamped,
} from "../helpers/fake-client.js";
import { makeLog } from "../helpers/log.js";

const REQUEST_ID = ("0x" + "11".repeat(32)) as `0x${string}`;
const USER = "0x1111111111111111111111111111111111111111" as const;
const ASSET = "0x2222222222222222222222222222222222222222" as const;

const WITHDRAWAL_REQUESTED_EVENT = {
    type: "event",
    name: "WithdrawalRequested",
    inputs: [
        { name: "requestId", type: "bytes32", indexed: true },
        { name: "user", type: "address", indexed: true },
        { name: "asset", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
        { name: "targetChainId", type: "uint256", indexed: false },
    ],
} as const;

const WITHDRAWAL_AUTHORIZED_EVENT = {
    type: "event",
    name: "WithdrawalAuthorized",
    inputs: [{ name: "requestId", type: "bytes32", indexed: true }],
} as const;

const WITHDRAWAL_COMPLETED_EVENT = {
    type: "event",
    name: "WithdrawalCompleted",
    inputs: [{ name: "requestId", type: "bytes32", indexed: true }],
} as const;

const WITHDRAWAL_FAILED_EVENT = {
    type: "event",
    name: "WithdrawalFailed",
    inputs: [{ name: "requestId", type: "bytes32", indexed: true }],
} as const;

const PAYOUT_DISPATCHED_EVENT = {
    type: "event",
    name: "PayoutDispatched",
    inputs: [
        { name: "requestId", type: "bytes32", indexed: true },
        { name: "targetChainId", type: "uint256", indexed: true },
        { name: "lzGuid", type: "bytes32", indexed: false },
    ],
} as const;

const CHAIN_LIQUIDITY_INC_EVENT = {
    type: "event",
    name: "ChainLiquidityIncremented",
    inputs: [
        { name: "asset", type: "address", indexed: true },
        { name: "chainId", type: "uint256", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
        { name: "newTotal", type: "uint256", indexed: false },
    ],
} as const;

describe("withdrawal-registry processor", () => {
    test("WithdrawalRequested inserts row in PENDING with full stamps", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);
        await withdrawalRequested.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: WITHDRAWAL_REQUESTED_EVENT,
                args: {
                    requestId: REQUEST_ID,
                    user: USER,
                    asset: ASSET,
                    amount: 1000n,
                    targetChainId: 84532n,
                },
            }),
        });
        const ins = fake.findBySqlContains("INSERT INTO withdrawal_request");
        expect(ins).toBeDefined();
        expect(ins!.sql).toContain("'PENDING'");
        expect(ins!.sql).toContain("ON CONFLICT (request_id) DO NOTHING");
        // params order: requestId, user, asset, amount, targetChain, tx, logIdx, blockHash, blockNum
        expect(ins!.params[0]).toEqual(hexToBytea(REQUEST_ID));
        expect(ins!.params[3]).toBe("1000");
        expect(ins!.params[4]).toBe(84532); // Number(targetChainId)
    });

    test("WithdrawalAuthorized transitions PENDING → PROCESSING", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);
        await withdrawalAuthorized.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: WITHDRAWAL_AUTHORIZED_EVENT,
                args: { requestId: REQUEST_ID },
            }),
        });
        const upd = fake.findBySqlContains("UPDATE withdrawal_request");
        expect(upd).toBeDefined();
        expect(upd!.sql).toContain("state IN ('PENDING')");
        expect(upd!.params[1]).toBe("PROCESSING");
    });

    test("WithdrawalCompleted transitions and stamps completed_at", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);
        await withdrawalCompleted.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: WITHDRAWAL_COMPLETED_EVENT,
                args: { requestId: REQUEST_ID },
            }),
        });
        const upd = fake.findBySqlContains("UPDATE withdrawal_request");
        expect(upd).toBeDefined();
        expect(upd!.sql).toContain("completed_at = now()");
        expect(upd!.sql).toContain("state IN ('PENDING', 'PROCESSING')");
        expect(upd!.params[1]).toBe("COMPLETED");
    });

    test("WithdrawalFailed transitions to FAILED without completed_at", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);
        await withdrawalFailed.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: WITHDRAWAL_FAILED_EVENT,
                args: { requestId: REQUEST_ID },
            }),
        });
        const upd = fake.findBySqlContains("UPDATE withdrawal_request");
        expect(upd).toBeDefined();
        expect(upd!.sql).not.toContain("completed_at");
        expect(upd!.params[1]).toBe("FAILED");
    });

    test("PayoutDispatched refreshes stamps without changing state", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);
        await payoutDispatched.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: PAYOUT_DISPATCHED_EVENT,
                args: {
                    requestId: REQUEST_ID,
                    targetChainId: 84532n,
                    lzGuid: ("0x" + "ab".repeat(32)) as `0x${string}`,
                },
            }),
        });
        const upd = fake.findBySqlContains("UPDATE withdrawal_request");
        expect(upd).toBeDefined();
        // No state mutation — the SET clause only refreshes stamps + updated_at
        // (so no parameterized `state = $` assignment). A defensive
        // `AND state = 'PROCESSING'` WHERE guard IS expected and asserted below:
        // a replayed/duplicate PayoutDispatched must not re-stamp a row that has
        // since moved to a terminal COMPLETED/FAILED state.
        expect(upd!.sql).not.toContain("state = $");
        expect(upd!.sql).toContain("WHERE request_id = $1");
        expect(upd!.sql).toContain("state = 'PROCESSING'");
    });

    test("ChainLiquidityIncremented writes newTotal verbatim, not a delta", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);
        await chainLiquidityIncremented.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: CHAIN_LIQUIDITY_INC_EVENT,
                args: {
                    asset: ASSET,
                    chainId: 84532n,
                    amount: 100n,
                    newTotal: 5000n,
                },
            }),
        });
        const ins = fake.findBySqlContains("INSERT INTO chain_liquidity");
        expect(ins).toBeDefined();
        expect(ins!.sql).toContain("amount = EXCLUDED.amount");
        // params: token, chainId, newTotal (not amount), tx, logIdx, blockHash, blockNum
        expect(ins!.params[2]).toBe("5000");
    });
});

/**
 * Idempotency: every handler consults `alreadyApplied` (SELECT count on
 * applied_by_tx_hash / applied_by_log_index) before mutating. When the same
 * (tx_hash, log_index) has already been stamped — the indexer tail re-seeing an
 * event an eager-path writer already applied, or a duplicate log delivery — the
 * handler must early-return and issue NO mutation. We stage the guard SELECT to
 * return 1 and assert the only recorded query is that guard.
 */
describe("withdrawal-registry processor — idempotency (already-stamped no-op)", () => {
    test("WithdrawalRequested skips the INSERT when (tx_hash, log_index) is already stamped", async () => {
        const fake = new FakePoolClient();
        stageAlreadyStamped(fake);
        await withdrawalRequested.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: WITHDRAWAL_REQUESTED_EVENT,
                args: {
                    requestId: REQUEST_ID,
                    user: USER,
                    asset: ASSET,
                    amount: 1000n,
                    targetChainId: 84532n,
                },
            }),
        });
        expect(
            fake.findBySqlContains("INSERT INTO withdrawal_request"),
        ).toBeUndefined();
        // The idempotency guard SELECT is the only DB round-trip.
        expect(fake.recorded).toHaveLength(1);
        expect(fake.recorded[0].sql).toContain("count(*)");
    });

    test("WithdrawalAuthorized transition is a no-op when already stamped", async () => {
        const fake = new FakePoolClient();
        stageAlreadyStamped(fake);
        await withdrawalAuthorized.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: WITHDRAWAL_AUTHORIZED_EVENT,
                args: { requestId: REQUEST_ID },
            }),
        });
        expect(
            fake.findBySqlContains("UPDATE withdrawal_request"),
        ).toBeUndefined();
        expect(fake.recorded).toHaveLength(1);
    });

    test("PayoutDispatched re-stamp is a no-op when already stamped", async () => {
        const fake = new FakePoolClient();
        stageAlreadyStamped(fake);
        await payoutDispatched.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: PAYOUT_DISPATCHED_EVENT,
                args: {
                    requestId: REQUEST_ID,
                    targetChainId: 84532n,
                    lzGuid: ("0x" + "ab".repeat(32)) as `0x${string}`,
                },
            }),
        });
        expect(
            fake.findBySqlContains("UPDATE withdrawal_request"),
        ).toBeUndefined();
        expect(fake.recorded).toHaveLength(1);
    });

    test("ChainLiquidityIncremented skips the upsert when already stamped", async () => {
        const fake = new FakePoolClient();
        stageAlreadyStamped(fake);
        await chainLiquidityIncremented.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: CHAIN_LIQUIDITY_INC_EVENT,
                args: {
                    asset: ASSET,
                    chainId: 84532n,
                    amount: 100n,
                    newTotal: 5000n,
                },
            }),
        });
        expect(
            fake.findBySqlContains("INSERT INTO chain_liquidity"),
        ).toBeUndefined();
        expect(fake.recorded).toHaveLength(1);
    });
});
