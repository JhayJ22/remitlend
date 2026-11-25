# Contributor Troubleshooting

This guide covers common issues contributors run into while working on the
backend and how to resolve them.

## Pact consumer contract testing

The backend integrates with several external APIs (Stellar Horizon, SendGrid,
Twilio). To catch breaking changes before they reach production we use
[Pact](https://docs.pact.io/) consumer contract tests.

### How it works

- `backend/src/__tests__/consumerContracts.test.ts` defines the consumer
  expectations for each integration:
  - **Stellar Horizon**: `GET /accounts/:id`, `POST /transactions`,
    `GET /transactions/:hash`
  - **SendGrid**: `POST /v3/mail/send`
  - **Twilio**: `POST /Messages`
- Running the test suite records the generated contracts to
  `backend/src/__tests__/contracts/pacts/`.
- CI (`.github/workflows/reusable-backend.yml`) runs a Pact verify step against
  the recorded contracts. If a contract breaks, the step fails and prints a diff
  showing exactly what changed.

### Running the contract tests locally

From the `backend` directory:

```bash
npm test -- consumerContracts
```

This regenerates the pact files under
`backend/src/__tests__/contracts/pacts/`. Commit any intentional contract
changes alongside the code that caused them.

### Verifying contracts locally

To run the same verification CI performs:

```bash
npm run pact:verify
```

If verification fails, inspect the diff in the output. A failure usually means
one of the following:

- A request path, method, or body shape changed in the integration code.
- A required field was added or removed from a request payload.
- The expected response schema no longer matches what the consumer relies on.

### Updating a contract

1. Update the relevant interaction in
   `backend/src/__tests__/consumerContracts.test.ts`.
2. Re-run `npm test -- consumerContracts` to regenerate the pact files.
3. Run `npm run pact:verify` to confirm the new contract passes.
4. Commit both the test change and the regenerated pact files.

### Common problems

- **Pact files not generated**: make sure you run the tests from the `backend`
  directory so the output path resolves correctly.
- **Verify step fails only in CI**: confirm the committed pact files match the
  ones generated locally (run the tests and check `git status`).
- **Stale contracts**: delete the files in
  `backend/src/__tests__/contracts/pacts/` and re-run the contract tests to
  regenerate them from scratch.
