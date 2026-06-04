import {
    clearChainWedged,
    isChainWedged,
    markChainWedged,
    wedgedChainIds,
} from "../../src/core/wedged-chains.js";

const HUB = 421614;
const SPOKE = 84532;

describe("wedged-chains registry (H1)", () => {
    afterEach(() => {
        clearChainWedged(HUB);
        clearChainWedged(SPOKE);
    });

    test("mark then clear toggles per-chain wedged state", () => {
        expect(isChainWedged(HUB)).toBe(false);
        markChainWedged(HUB);
        expect(isChainWedged(HUB)).toBe(true);
        expect(wedgedChainIds()).toContain(HUB);
        clearChainWedged(HUB);
        expect(isChainWedged(HUB)).toBe(false);
        expect(wedgedChainIds()).not.toContain(HUB);
    });

    test("wedging one chain does not wedge another (per-chain isolation)", () => {
        markChainWedged(SPOKE);
        expect(isChainWedged(SPOKE)).toBe(true);
        expect(isChainWedged(HUB)).toBe(false);
    });
});
