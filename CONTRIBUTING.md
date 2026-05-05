# Contributing to mongoose-lens

## Setup

```sh
git clone https://github.com/maku85/mongoose-lens.git
cd mongoose-lens
pnpm install
```

## Workflow

```sh
pnpm test          # run the full test suite (requires no external services)
pnpm typecheck     # TypeScript type check
pnpm lint          # Biome lint + format check
pnpm lint:fix      # auto-fix lint issues
pnpm build         # compile ESM + CJS output
```

The test suite spins up an in-memory MongoDB instance automatically — no local MongoDB installation needed.

## Making changes

1. Open an issue first for non-trivial changes so we can align on the approach.
2. Create a branch from `main`.
3. Write or update tests for whatever you change.
4. Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
5. Open a PR — the CI must be green before merging.

## Commit style

Use conventional commits (`fix:`, `feat:`, `chore:`, `docs:`). Keep the subject line under 72 characters.

## Releasing (maintainers only)

Make sure you are logged in to npm (`pnpm login`) and that your working tree is clean, then:

1. Move `[Unreleased]` entries to a new `[x.y.z] - YYYY-MM-DD` section in CHANGELOG.md and commit.
2. Run the release script:
   ```sh
   pnpm release patch   # 0.1.0 → 0.1.1
   pnpm release minor   # 0.1.0 → 0.2.0
   pnpm release major   # 0.1.0 → 1.0.0
   ```

The script will: bump the version, create a git commit and tag, push both to origin, then run `pnpm publish` (which triggers `prepublishOnly`: build + full test suite).
