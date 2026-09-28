# Risk Disclosure and Financial Terminology

This document describes the risks associated with using RemitLend and defines
the financial terms used across the protocol, application, and documentation.
Read it before depositing funds or taking a loan.

> **Not financial advice.** This document is for informational purposes only.
> RemitLend is experimental software deployed on a public blockchain.  You may
> lose all funds you commit to the protocol.

---

## Glossary of financial terms

| Term | Definition as used in RemitLend |
|---|---|
| **Basis point (bps)** | 1/100 of one percent (0.01 %).  Interest rates are expressed in basis points to avoid floating-point rounding errors in contracts. |
| **Stroop** | The smallest unit of Stellar's native asset (XLM) and of USDC-style pool tokens: 1 stroop = 10⁻⁷ of the base token.  All on-chain arithmetic uses integer stroops. |
| **Credit score** | An integer derived from on-chain remittance history.  Higher is better.  The exact formula is documented in the backend credit-scoring service and is not guaranteed to remain stable. |
| **Remittance NFT** | A Soroban-based token that encodes a borrower's remittance history and credit score.  It serves as both proof of eligibility and collateral. |
| **Lending pool** | A smart contract that holds deposited funds and issues loans.  Depositors receive pool tokens representing their proportional share. |
| **Pool token** | A fungible token issued to lenders when they deposit into the lending pool.  Redeemable for the underlying asset plus accrued interest. |
| **Interest rate** | Annual rate expressed in basis points, stored in the `lending_pool` contract's `interest_rate_bps` parameter.  See [protocol parameter governance](./protocol-parameter-governance.md) for how this is changed. |
| **Nominal APR** | The annual interest rate charged on the principal, before any fees.  This is the rate a loan is actually issued at. |
| **Effective APR** | The nominal APR with every borrower-borne fee (origination, service, and the annualised cost of any other charge) expressed as an annual rate over the actual term.  It is always greater than or equal to the nominal APR.  See [loan cost disclosure](./loan-cost-disclosure.md). |
| **Total cost of credit** | Interest over the full term plus all upfront fees.  The frontend always displays it itemised, with exact arithmetic, so it can never disagree with the displayed total repayment. |
| **Amount financed** | The principal actually disbursed, i.e. the requested amount minus any upfront fees deducted at disbursement.  It can be lower than the requested principal. |
| **Network fee** | The Stellar transaction fee, paid in XLM.  It is disclosed separately and is **not** part of the repayment total. |
| **Liquidation threshold** | The collateral-to-loan ratio below which a position can be liquidated.  Stored as `liquidation_threshold` in the `lending_pool` contract. |
| **Timelock** | A mandatory waiting period enforced on-chain before a governance decision or contract upgrade takes effect.  Cannot be bypassed by any party. |
| **APY (Annual Percentage Yield)** | The effective annual return including compounding.  Displayed in the UI as an estimate; actual yield depends on pool utilisation. |
| **Utilisation rate** | The proportion of deposited funds currently lent out.  Higher utilisation generally implies higher interest rates under variable-rate models. |

---

## Risk categories

### 1. Smart contract risk

RemitLend's contracts are written in Rust targeting the Soroban VM.  Bugs in
contract logic can lead to loss of funds.

- Contracts have been tested with unit tests, snapshot tests, and a fuzz
  campaign (see `contracts/fuzz/`).
- No formal external audit has been completed at the time of this writing.
  The absence of an audit does not imply the absence of vulnerabilities.
- Contract upgrades are gated behind a 48 h upgrade-proxy timelock and a
  governance quorum.  Users have at least 48 hours notice before any upgrade
  takes effect.

### 2. Governance / admin key risk

The protocol is controlled by a multi-sig governance contract.

- A quorum of signers can change financial parameters (interest rates,
  liquidation thresholds) after the 24 h minimum timelock.
- If a majority of signing keys are compromised, the attacker could drain the
  protocol after waiting out the timelock.
- The 24 h timelock provides a response window but does not guarantee safety if
  users do not monitor governance activity.

**Mitigation**: subscribe to the `pool.parameters_updated` and governance
audit-log events to receive notification of pending changes.

### 3. Oracle / data risk

RemitLend uses on-chain remittance history as a credit signal.  There is no
external price oracle at this time.

- If a user's wallet is compromised, an attacker could manipulate their
  remittance history before an oracle is in place.
- The credit score algorithm is not audited by a third party.

### 4. Liquidation risk (borrowers)

If the value of a borrower's collateral (Remittance NFT + locked tokens) falls
below the `liquidation_threshold`, any user may trigger liquidation.

- Liquidation is irreversible.
- The liquidation threshold is a governance-controlled parameter and may
  change during the life of a loan, subject to the 24 h timelock.

### 5. Liquidity risk (lenders)

Lenders deposit funds into the lending pool and receive pool tokens.

- Withdrawal is subject to available liquidity.  If utilisation is at 100 %,
  lenders cannot withdraw until loans are repaid.
- There is no deposit insurance or bail-out mechanism.

### 6. Network and infrastructure risk

- The Stellar network can experience outages.  During an outage, loan
  repayments, liquidations, and withdrawals are paused.
- The backend API is not a critical path for on-chain actions (users can
  interact with contracts directly via Soroban CLI), but it does serve the
  credit-score computation required to originate new loans.
- The emergency-pause mechanism (see `contracts/EMERGENCY_PAUSE_PATTERN.md`)
  can freeze the protocol in the event of a detected exploit.

### 7. Regulatory risk

Laws governing DeFi lending, stablecoins, and NFT-based collateral vary by
jurisdiction and are rapidly evolving.  Users are responsible for determining
whether using RemitLend is lawful in their jurisdiction.

### 8. Key / wallet risk

Stellar private keys are not recoverable if lost.  There is no account-recovery
mechanism.  If you lose access to your wallet, you lose access to your funds
and NFTs.

---

## User responsibilities

- Keep your Stellar private key secure and never share it.
- Monitor your loan health ratio; do not rely solely on UI notifications.
- Review pending governance proposals at `docs/protocol-parameter-governance.md`
  and on-chain before they take effect.
- Test with small amounts before committing significant capital, especially on
  new deployments.

---

## Compatibility and stability commitments

| Commitment | Scope |
|---|---|
| Breaking API changes | Announced in GitHub and in `CHANGELOG.md` ≥ 48 h before deployment |
| Financial parameter changes | On-chain proposal visible ≥ 24 h before execution |
| Contract upgrades | On-chain scheduled ≥ 48 h before execution |
| Credit score algorithm changes | Announced via ADR (see `docs/adr/`) ≥ one release cycle |

RemitLend does not provide any guarantee of uptime, accuracy of credit scores,
or future availability of the protocol.

---

## Reporting vulnerabilities

Security vulnerabilities must be reported privately.  See
[SECURITY.md](../SECURITY.md) for the responsible-disclosure process.  Do not
open public issues for security bugs.
