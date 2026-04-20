import type { Hex } from "viem";

/** Convert a 0x-prefixed hex string to a Buffer suitable for BYTEA columns. */
export function hexToBytea(hex: Hex): Buffer {
    const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (stripped.length % 2 !== 0) {
        throw new Error(`hexToBytea: odd-length hex ${hex}`);
    }
    return Buffer.from(stripped, "hex");
}

/** Convert a pg BYTEA Buffer back to a lower-case 0x-prefixed hex string. */
export function byteaToHex(buf: Buffer): Hex {
    return `0x${buf.toString("hex")}` as Hex;
}
