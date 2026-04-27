import { settlementLedgerProcessors } from "../../src/processors/settlement-ledger.processor.js";

describe("settlement-ledger processor (Phase 1 dormant)", () => {
    test("exports an empty processor list — solver flow not active in Phase 1", () => {
        expect(settlementLedgerProcessors).toEqual([]);
    });
});
