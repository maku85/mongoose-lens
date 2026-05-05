"use strict";

/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.ts"],
  // Map .js extensions in ESM-style source imports to their .ts counterparts.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "CommonJS",
          moduleResolution: "node",
          resolveJsonModule: true,
          esModuleInterop: true,
        },
      },
    ],
  },
  // mongodb-memory-server downloads binaries on first run.
  testTimeout: 60_000,
  // Run files serially to avoid MongoMemoryServer port conflicts.
  maxWorkers: 1,
};
