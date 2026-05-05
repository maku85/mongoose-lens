"use strict";
// Release helper — run with: pnpm release [patch|minor|major]
// Steps:
//   1. Checks git working tree is clean
//   2. Bumps version (npm version → commit + tag)
//   3. Pushes commit and tag to origin
//   4. Publishes to npm (prepublishOnly runs build + tests automatically)

const { execSync } = require("child_process");

const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("Usage: pnpm release [patch|minor|major]");
  process.exit(1);
}

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

// Ensure working tree is clean
const status = execSync("git status --porcelain").toString().trim();
if (status) {
  console.error("Working tree is not clean. Commit or stash your changes first.");
  process.exit(1);
}

run(`npm version ${bump} --no-git-tag-version`);

const version = require("../package.json").version;

run(`git add package.json`);
run(`git commit -m "chore: release v${version}"`);
run(`git tag v${version}`);
run(`git push && git push --tags`);
run(`pnpm publish --no-git-checks`);

console.log(`\n✓ v${version} published`);
