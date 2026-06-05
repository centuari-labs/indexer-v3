import { pruneRecentHashes } from "../../src/core/recent-hashes.js";
import { FakePoolClient, asPoolClient } from "../helpers/fake-client.js";

const HUB = 421614;

describe("pruneRecentHashes — M1 window floor", () => {
    test("clamps the cutoff so the last finalityDepth hashes below head survive", async () => {
        const fake = new FakePoolClient();
        // head=1000, finalityDepth=12 → protectedFloor=988. A caller asking to
        // prune <= 995 would erase blocks 989-995 that the reorg detector still
        // needs; the clamp drops the cutoff to 988.
        await pruneRecentHashes(asPoolClient(fake), HUB, 995n, 1000n, 12);
        const del = fake.findBySqlContains("DELETE FROM recent_block_hashes");
        expect(del).toBeDefined();
        expect(del!.params[1]).toBe("988");
    });

    test("leaves a conservative cutoff untouched when it's already below the floor", async () => {
        const fake = new FakePoolClient();
        // cutoff 900 < protectedFloor 988 → keep 900.
        await pruneRecentHashes(asPoolClient(fake), HUB, 900n, 1000n, 12);
        const del = fake.findBySqlContains("DELETE FROM recent_block_hashes");
        expect(del!.params[1]).toBe("900");
    });

    test("never deletes when the clamped cutoff is negative (early chain)", async () => {
        const fake = new FakePoolClient();
        // head=5, finalityDepth=12 → protectedFloor=-7 → clamped negative → no-op.
        await pruneRecentHashes(asPoolClient(fake), HUB, 3n, 5n, 12);
        expect(
            fake.findBySqlContains("DELETE FROM recent_block_hashes"),
        ).toBeUndefined();
    });
});
