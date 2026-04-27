import { jest } from "@jest/globals";
import type { PublicClient } from "viem";
import type { BlockCursorRow } from "../../src/core/block-cursor.js";
import { findForkPoint } from "../../src/core/reorg-detector.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { FakePoolClient, asPoolClient } from "../helpers/fake-client.js";

const HUB = 421614;
const HASH = (n: number): `0x${string}` =>
    `0x${n.toString(16).padStart(2, "0").repeat(32)}`;

interface FakeBlock {
    hash: `0x${string}` | null;
}

function makeViemClient(
    blocks: Map<bigint, FakeBlock>,
): PublicClient {
    return {
        getBlock: jest.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
            return blocks.get(blockNumber) ?? { hash: null };
        }),
    } as unknown as PublicClient;
}

describe("findForkPoint", () => {
    const cursor: BlockCursorRow = {
        chainId: HUB,
        lastBlock: 110n,
        lastBlockHash: HASH(0xaa),
    };

    test("returns undefined when persisted hash matches live chain at cursor", async () => {
        const fake = new FakePoolClient();
        const viem = makeViemClient(
            new Map([[110n, { hash: HASH(0xaa) }]]),
        );
        const result = await findForkPoint(viem, asPoolClient(fake), cursor, 12);
        expect(result).toBeUndefined();
        // Critical: should not query recent_hashes when no reorg.
        expect(fake.recorded).toHaveLength(0);
    });

    test("walks newest→oldest and returns the highest matching block as fork point", async () => {
        const fake = new FakePoolClient();
        // recent-hashes returns rows newest-first per the query in recent-hashes.ts
        fake.queueResponse([
            // 110 — diverged
            { block_number: "110", block_hash: hexToBytea(HASH(0xbb)) },
            // 109 — diverged
            { block_number: "109", block_hash: hexToBytea(HASH(0xcc)) },
            // 108 — matches live chain (fork point)
            { block_number: "108", block_hash: hexToBytea(HASH(0xdd)) },
            // 107 — would also match but iteration stops at the first match
            { block_number: "107", block_hash: hexToBytea(HASH(0xee)) },
        ]);
        const viem = makeViemClient(
            new Map([
                [110n, { hash: HASH(0x11) }], // diverged
                [109n, { hash: HASH(0x22) }], // diverged
                [108n, { hash: HASH(0xdd) }], // matches persisted
                [107n, { hash: HASH(0xee) }],
            ]),
        );
        const result = await findForkPoint(viem, asPoolClient(fake), cursor, 12);
        expect(result).toEqual({
            forkPointBlock: 108n,
            forkPointBlockHash: HASH(0xdd),
        });
    });

    test("throws when reorg is deeper than finalityDepth (no persisted hash matches)", async () => {
        const fake = new FakePoolClient();
        fake.queueResponse([
            { block_number: "110", block_hash: hexToBytea(HASH(0xbb)) },
            { block_number: "109", block_hash: hexToBytea(HASH(0xcc)) },
        ]);
        const viem = makeViemClient(
            new Map([
                [110n, { hash: HASH(0x11) }],
                [109n, { hash: HASH(0x22) }],
            ]),
        );
        await expect(
            findForkPoint(viem, asPoolClient(fake), cursor, 12),
        ).rejects.toThrow(/deeper than finalityDepth/);
    });

    test("throws when recent_block_hashes is empty during a reorg", async () => {
        const fake = new FakePoolClient();
        fake.queueResponse([]); // no persisted recent hashes
        const viem = makeViemClient(
            new Map([[110n, { hash: HASH(0x11) }]]), // diverged
        );
        await expect(
            findForkPoint(viem, asPoolClient(fake), cursor, 12),
        ).rejects.toThrow(/recent_block_hashes is empty/);
    });
});
