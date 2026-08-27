# RemittanceNFT Transfer Events and Indexing

## Overview

Transfer events for RemittanceNFT are now emitted with detailed indexable data, enabling efficient on-chain and off-chain querying of NFT transfer history.

## Event Structures

### NftTransferEvent (Indexed)

The primary transfer event with structured data for indexing:

```rust
pub struct NftTransferEvent {
    pub from: Address,      // Source address
    pub to: Address,        // Destination address
    pub score: u32,         // Credit score at time of transfer
    pub ledger: u32,        // Ledger sequence number
}
```

**Event Topic**: `NftTransferred`

This event is published for every successful NFT transfer and contains all information needed to reconstruct transfer history.

### Legacy Transfer Event

For backward compatibility, a legacy event is also emitted:

```
Topic: "Transfer"
Data: (from_address, to_address)
```

This event should be considered deprecated and new integrations should use `NftTransferEvent`.

## Indexing Strategy

### Event Fields

The `NftTransferEvent` structure provides these indexable fields:

1. **from**: Indexed address for querying outbound transfers
2. **to**: Indexed address for querying inbound transfers
3. **score**: The credit score at transfer time (useful for analytics)
4. **ledger**: Ledger sequence for chronological ordering

### Query Patterns

With proper indexing, the following queries are efficient:

1. **Get all transfers for an address** (incoming + outgoing):
   ```
   WHERE from == address OR to == address
   ORDER BY ledger ASC
   ```

2. **Get incoming transfers to an address**:
   ```
   WHERE to == address
   ORDER BY ledger DESC
   LIMIT 10
   ```

3. **Get outgoing transfers from an address**:
   ```
   WHERE from == address
   ORDER BY ledger DESC
   LIMIT 10
   ```

4. **Get transfers in a ledger range** (time-based queries):
   ```
   WHERE ledger >= ledger_start AND ledger <= ledger_end
   ORDER BY ledger ASC
   ```

5. **Get transfer volume by score**:
   ```
   WHERE score >= min_score
   AGGREGATE COUNT(*), SUM(score)
   ```

## Backend Integration

The backend should:

1. **Listen for NftTransferEvent events** from the RemittanceNFT contract
2. **Parse and store transfer records** in a queryable database
3. **Index by both from and to addresses** for efficient lookups
4. **Maintain chronological order** by ledger sequence
5. **Expose query endpoints** for client applications

### Database Schema

Recommended table structure for transfer history:

```sql
CREATE TABLE nft_transfer_events (
    id BIGSERIAL PRIMARY KEY,
    from_address VARCHAR(56) NOT NULL,
    to_address VARCHAR(56) NOT NULL,
    score INTEGER NOT NULL,
    ledger_sequence INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Indexes for efficient querying
    INDEX idx_from_ledger (from_address, ledger_sequence DESC),
    INDEX idx_to_ledger (to_address, ledger_sequence DESC),
    INDEX idx_ledger (ledger_sequence DESC),
    INDEX idx_created_at (created_at DESC)
);
```

### API Endpoints

The backend should expose endpoints like:

```
GET /api/nft/transfers/for/:address
  - Get all transfers (incoming + outgoing) for an address
  - Query params: limit, offset, order_by (ledger|date)

GET /api/nft/transfers/to/:address
  - Get all incoming transfers to an address
  - Query params: limit, offset

GET /api/nft/transfers/from/:address
  - Get all outgoing transfers from an address
  - Query params: limit, offset

GET /api/nft/transfers/ledger/:start/:end
  - Get transfers in a ledger range
  - Query params: limit, offset

GET /api/nft/transfer-history/:address
  - Get paginated transfer history for user
  - Query params: page, per_page
```

## Event Emission Example

When a transfer is initiated:

```rust
// The contract emits:
let transfer_event = NftTransferEvent {
    from: borrower_address,
    to: new_owner_address,
    score: borrower_score,
    ledger: env.ledger().sequence(),
};
env.events().publish((Symbol::new(&env, "NftTransferred"),), transfer_event);
```

An off-chain indexer listening to the RemittanceNFT contract will capture this event and persist it.

## Historical Analysis

With indexed transfer events, the backend can:

1. **Build transfer graphs**: Show relationships between addresses
2. **Track reputation movement**: Monitor score distribution
3. **Detect patterns**: Identify unusual transfer activity
4. **Generate analytics**: Create transfer statistics and reports
5. **Enable user dashboard**: Show transfer history to users

## Backward Compatibility

The legacy "Transfer" event is still emitted but should not be used for new implementations. The detailed `NftTransferEvent` structure provides:

- Better structured data (avoids parsing ambiguity)
- Direct access to score and ledger information
- Clearer intent through explicit struct fields
- Reduced need for additional on-chain queries

## Future Enhancements

1. **Batch Transfer Events**: Support bulk operations with single event
2. **Transfer Metadata**: Include transfer reason (manual, default, remint)
3. **Multi-sig Transfers**: Track authorization chain for complex transfers
4. **Freeze Status**: Include frozen/paused status at transfer time
5. **Historical State**: Snapshot full metadata at transfer for audit trail

## Testing

Events are tested in `contracts/remittance_nft/src/test.rs`:

```rust
#[test]
fn test_transfer_emits_indexed_event() {
    // Create NFT and transfer
    // Assert event structure includes all fields
    // Verify ledger sequence is correct
    // Check score is accurate
}
```

## Monitoring

Track transfer event health via:

1. **Event emission rate**: Events per ledger
2. **Event parsing errors**: Failed to parse NftTransferEvent
3. **Indexing lag**: Delay between event and database insertion
4. **Query performance**: Response time for transfer history queries
