import {
    getCursor,
    rewindTo,
    upsertCursor,
} from "../../src/core/block-cursor.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { FakePoolClient, asPoolClient } from "../helpers/fake-client.js";

const HUB = 421614;
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("block-cursor", () => {
    test("getCursor returns undefined when no row exists", async () => {
        const fake = new FakePoolClient();
        const result = await getCursor(asPoolClient(fake), HUB);
        expect(result).toBeUndefined();
        expect(fake.recorded[0]?.sql).toContain("SELECT chain_id, last_block");
        expect(fake.recorded[0]?.params[0]).toBe(HUB);
    });

    test("getCursor parses last_block as bigint and hash as hex", async () => {
        const fake = new FakePoolClient();
        fake.queueResponse([
            {
                chain_id: HUB,
                last_block: "12345",
                last_block_hash: hexToBytea(HASH),
            },
        ]);
        const result = await getCursor(asPoolClient(fake), HUB);
        expect(result).toEqual({
            chainId: HUB,
            lastBlock: 12345n,
            lastBlockHash: HASH,
        });
    });

    test("upsertCursor uses INSERT ... ON CONFLICT (chain_id) DO UPDATE", async () => {
        const fake = new FakePoolClient();
        await upsertCursor(asPoolClient(fake), {
            chainId: HUB,
            lastBlock: 999n,
            lastBlockHash: HASH,
        });
        const ins = fake.recorded[0];
        expect(ins?.sql).toContain("INSERT INTO block_cursor");
        expect(ins?.sql).toContain("ON CONFLICT (chain_id) DO UPDATE");
        expect(ins?.params[0]).toBe(HUB);
        expect(ins?.params[1]).toBe("999");
        expect(ins?.params[2]).toEqual(hexToBytea(HASH));
    });

    test("rewindTo deletes from every stamped table + deposit_event + recent_hashes + reseats cursor", async () => {
        const fake = new FakePoolClient();
        await rewindTo(asPoolClient(fake), HUB, 100n, HASH);

        const stampedTables = [
            "user_balance",
            "withdrawal_request",
            "cross_chain_deposit",
            "chain_liquidity",
            "market",
            "borrow_position",
            "lend_position",
        ];
        for (const t of stampedTables) {
            const del = fake.findBySqlContains(`DELETE FROM ${t}`);
            expect(del).toBeDefined();
            expect(del!.sql).toContain("applied_by_block_number > $1");
            expect(del!.params[0]).toBe("100");
        }

        // deposit_event uses block_number directly (chain-scoped)
        const depEv = fake.findBySqlContains("DELETE FROM deposit_event");
        expect(depEv).toBeDefined();
        expect(depEv!.sql).toContain("chain_id = $1 AND block_number > $2");
        expect(depEv!.params[0]).toBe(HUB);
        expect(depEv!.params[1]).toBe("100");

        // recent_block_hashes pruned past fork
        const rec = fake.findBySqlContains("DELETE FROM recent_block_hashes");
        expect(rec).toBeDefined();

        // Cursor finally upserted to fork point
        const upsert = fake.findBySqlContains("INSERT INTO block_cursor");
        expect(upsert).toBeDefined();
        expect(upsert!.params[1]).toBe("100");
        expect(upsert!.params[2]).toEqual(hexToBytea(HASH));
    });
});
