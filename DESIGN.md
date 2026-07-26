# Design Notes

## 1. What issues did you find?

- **Transfer Race Condition:** `transfer()` used a read-modify-write pattern that allowed balances to drop below zero under high concurrency (Code reading).
- **MongoDB Deadlocks:** Bidirectional concurrent transfers between two users would cross-lock the database due to a lack of deterministic resource ordering (Architectural reasoning).
- **Cache Pollution:** Redis cache invalidation/updates occurred outside the transactional boundaries, leaving a race window for stale reads (Code reading).
- **Poison Pill Loop:** The RabbitMQ consumer blindly requeued all errors (`nack(..., true)`), meaning structural errors (e.g. malformed JSON) would block the queue forever (Code reading).
- **Consumer Overwrites:** The destination wallet credit used manual JS addition (`+= amount`), leading to lost credits during concurrent message processing (Code reading).
- **Double-Refund Race:** The pending transfer worker fetched stale records into memory without locking them. Horizontally scaled instances would double-refund the same timeout (Code reading).
- **Memory Leak & CPU Thrashing:** `WalletEventsWorker` registered infinite dynamic event listeners and executed wasteful polling queries every 10 seconds (Code reading).
- **Dashboard Memory Bloat:** The dashboard fetched all historical transactions into Node.js memory instead of using DB aggregations (Code reading).
- **Missing Schema Indexes:** The consumer lacked a compound index for `{ _id: 1, status: 1 }`, causing O(N) lookup degradation (Architectural reasoning).

## 2. What did you prioritize, and why?

1. **Financial Integrity (Severe):** Fixing the negative balance race conditions, deadlocks, consumer overwrites, and double refunds. If a ledger loses money, the company dies.
2. **System Stability (High):** Resolving the RabbitMQ poison pill loop and the Node.js memory leak. These cause catastrophic system-wide outages (OOMs and blocked queues).
3. **Performance (Medium):** Replacing DB polling with Change Streams and optimizing the dashboard query to ensure the system actually scales under load.

## 3. How did you handle concurrency?

- **API Transfers (Deadlock Prevention):** Implemented a deterministic lock hierarchy by sorting wallet IDs (`[fromWalletId, toWalletId].sort()`) before fetching. We replaced manual math with atomic `$inc` operators constrained by `$gte` to absolutely guarantee no negative balances under any interleaving.
- **Queue Consumers (Idempotency):** Pushed the state idempotency check (`status: PENDING` -> `COMPLETED`) directly into a `findOneAndUpdate` query to guarantee atomicity against simultaneous duplicate RabbitMQ deliveries.
- **Workers (Pessimistic Locks):** Used the transfer document's `status` field as an inherent pessimistic lock during refunds to prevent multi-node double refunds.

## 4. How did you ensure data consistency?

- **Cache Continuity:** Encapsulated all Redis `setCachedBalance` calls strictly inside the MongoDB `session.withTransaction()` boundaries. This guarantees that concurrent reads cannot fetch and cache a stale pre-commit state after the transaction commits but before the cache is invalidated.
- **Queue Integrity:** Differentiated fatal structural errors (dropped) from transient infrastructure errors (requeued) in the RabbitMQ `nack` block to maintain exact-once processing intent without stalling the queue.

## 5. Trade-offs

- **Redis Inside Transactions:** Writing to Redis inside a MongoDB transaction briefly holds the database lock open for a network roundtrip. I chose this conservative fix over a complex Change Data Capture (CDC) cache-invalidation pipeline to prioritize absolute consistency without over-engineering the infrastructure.
- **Dropped Messages vs. DLQ:** Currently, fatal errors in the consumer are dropped (`requeue: false`). This is simpler than setting up a Dead Letter Queue (DLQ), but sacrifices automated auditing of those failed events.

## 6. Remaining technical debt

- **Input Validation:** The codebase currently accepts any numeric `amount`. Without strict validation, floating-point decimals or negative numbers could bypass higher-level logic.
- **Outbox Publisher Guarantees:** The RabbitMQ publisher does not aggressively verify broker delivery confirmations before advancing outbox statuses, technically leaving a micro-window for message loss if the broker crashes mid-flight.
- **Soft Deletes:** The schema lacks soft deletes (`deletedAt`), which threatens the referential integrity of historical ledger entries if a user account is deleted.

## 7. What would you improve with another day?

- **Strict DTO Validation:** Implement Joi/Class-Validator constraints enforcing all amounts as strictly positive minor integers (cents) to prevent floating-point math errors.
- **Dead Letter Queue (DLQ):** Configure a formal DLQ exchange in RabbitMQ so that structurally poisoned messages are preserved for DevOps inspection instead of being dropped.
- **CDC Cache Invalidation:** Transition cache invalidation to an asynchronous MongoDB Change Stream pipeline (e.g., Debezium) to entirely decouple Redis latency from MongoDB transaction locks.

## 8. Assumptions

- **Replica Set:** Assumed MongoDB is running as a Replica Set, which is a hard prerequisite for multi-document ACID transactions to function.
- **Horizontal Scale:** Assumed the application is intended to be deployed across multiple Kubernetes pods/instances, which drove the necessity of stripping the local `EventEmitter` and fixing the sweeper locks.
