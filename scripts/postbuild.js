"use strict";
const { writeFileSync } = require("fs");
// Mark the ESM output directory as an ES module package so Node.js
// interprets the .js files there as ESM (even without "type":"module" at root).
writeFileSync("dist/esm/package.json", JSON.stringify({ type: "module" }, null, 2) + "\n");
console.log("postbuild: wrote dist/esm/package.json");
