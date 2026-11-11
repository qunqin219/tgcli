# Contributing

Thanks for taking a look. This is a small tool and it is meant to stay small.

## Ground rules

- **No runtime dependencies.** The CLI must run on a bare Node 18 install.
  If a feature seems to need a library, show what breaks when it is inlined.
- **The output envelope is a contract.** Any new command must print
  `{ ok, schema_version, data }` (or `{ ok:false, error }`) and return the same
  exit codes as the rest of the tool.
- **Never guess chat state.** If a command changes a chat, it also writes to the
  ledger; features that silently skip that step will be rejected in review.

## Workflow

```bash
npm test          # node --test, no install step needed
```

1. Open an issue describing the behaviour you want, or the bug with a
   reproduction.
2. Branch from `main`, keep commits focused, one concern per commit.
3. Add or update a test in `test/` — the suite uses `node:test` only.
4. Update `CHANGELOG.md` under an `Unreleased` heading.
5. Open a pull request and describe what you verified by hand.

## Releases

Maintainers tag `vX.Y.Z` on `main`. The release workflow runs the test suite,
publishes to npm, and creates a GitHub release with the changelog section for
that version.
