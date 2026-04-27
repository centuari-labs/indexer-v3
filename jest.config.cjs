/** @type {import('jest').Config} */
module.exports = {
    preset: "ts-jest/presets/default-esm",
    testEnvironment: "node",
    extensionsToTreatAsEsm: [".ts"],
    roots: ["<rootDir>/test"],
    testMatch: ["**/*.test.ts"],
    moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1",
    },
    transform: {
        "^.+\\.tsx?$": [
            "ts-jest",
            {
                useESM: true,
                tsconfig: "<rootDir>/tsconfig.test.json",
            },
        ],
    },
    clearMocks: true,
    setupFiles: ["<rootDir>/test/helpers/setup.ts"],
};
