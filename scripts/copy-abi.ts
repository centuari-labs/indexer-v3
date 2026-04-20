/**
 * Copies ABI JSON files from smart-contract-revamp/abi/ into src/abi/ so the
 * compiled indexer ships with a self-contained ABI tree.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const SRC = resolve(
    new URL(".", import.meta.url).pathname,
    "..",
    "..",
    "smart-contract-revamp",
    "abi",
);
const DST = resolve(
    new URL(".", import.meta.url).pathname,
    "..",
    "src",
    "abi",
);

async function main(): Promise<void> {
    await mkdir(DST, { recursive: true });
    const files = (await readdir(SRC)).filter((f) => f.endsWith(".json"));
    for (const f of files) {
        await cp(join(SRC, f), join(DST, f));
        console.log(`copied ${f}`);
    }
    console.log(`\ncopied ${files.length} ABI files → ${DST}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
