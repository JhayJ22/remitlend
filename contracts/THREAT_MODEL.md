# Formal Threat Model & Executable Attack Specifications

This document defines the formal security threat model, attack surfaces, and mitigation invariants across the RemitLend smart contract ecosystem (`lending_pool`, `loan_manager`, `multisig_governance`, `remittance_nft`).

---

## 1. System Assets & Trust Boundaries

### 1.1 Protected Assets
- **Pool Capital**: Underwriting and reserve funds deposited by institutional and retail liquidity providers.
- **Collateral & Remittance Rights**: Escrowed tokens and NFT claims representing active borrower commitments.
- **Administrative Privileges**: Execution rights for parameter updates, oracle configurations, emergency pause, and upgrades.

### 1.2 Trust Boundaries
- **Untrusted External Callers**: Arbitrary actors interacting with public entrypoints (`deposit`, `borrow`, `repay`, `claim`).
- **Oracle Infrastructure**: Semi-trusted price and remittance validation oracles subject to deviation and network latency.
- **Governance Signers**: Multi-sig participants authorized to propose and execute protocol adjustments under threshold consensus.

---

## 2. Attack Vectors & Invariant Tests

### 2.1 Reentrancy & Cross-Contract State Poisoning
- **Vector**: Reentrant callback during token transfers or NFT minting attempting to drain pool capital before balance updates.
- **Invariant**: State updates strictly precede external calls (Checks-Effects-Interactions pattern).

### 2.2 Oracle Manipulation & Flash Lending Attacks
- **Vector**: Spot price manipulation through decentralized liquidity pools within the same block to inflate borrowing capacity.
- **Invariant**: Oracle values must be checked against time-weighted bounds and multi-source dispersion metrics.

### 2.3 Unauthorized Administrative Role Escalation
- **Vector**: Malicious takeover of admin functions via single-step handover or signature replay.
- **Invariant**: All administrative handovers require a two-step propose-and-accept handshake with strict expiration bounds.

### 2.4 Token Transfer Failure & Defective Token Accounting
- **Vector**: Handling tokens with transfer fees, non-standard return values, or silent transfer failures without checking balance deltas.
- **Invariant**: Inbound transfers measure contract balance pre- and post-transfer to verify exact received amounts.
