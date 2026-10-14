# Contributing to Trove

Thank you for taking the time to help.

## Reporting a problem

Open an issue at https://github.com/LalwaniPalash/trove-mcp/issues. Please include:

- the Trove version (`trove://resources/version` or `npm ls trove-mcp`);
- the tool you called and its arguments;
- the full response envelope, including `status`, `warnings` and `provenance`;
- which optional keys were set (`SEMANTIC_SCHOLAR_API_KEY`, `CORE_API_KEY`, `UNPAYWALL_EMAIL`). Never paste the key values.

A provider outage or rate limit is not always a Trove bug. If the envelope shows a
provider warning, say so in the issue.

## Asking for help

Questions about setup or usage are welcome as issues. Label them `question`.

## Making a change

1. Fork the repository and create a branch from `main`.
2. `npm install`
3. Make the change, with a test for any behaviour change.
4. Run `npm run verify:release`. It runs the typecheck, unit tests and release-gate tests.
5. Open a pull request that explains what changed and why.

The release-gate tests in `tests/quality/` protect Trove's fail-closed contract. A change
that makes a tool return a fallback answer where it used to refuse will fail them. If you
believe a gate is wrong, explain why in the pull request instead of editing the test.

Live provider tests are optional and need network access:

```bash
LIVE_CONTRACT=1 npm run test:live
```

## Scope

Trove uses only public APIs and legal open-access links. Pull requests that add scraping,
paywall bypasses or shadow libraries will not be accepted.

## Conduct

Be respectful and professional. Harassment or personal attacks are not tolerated.
