# Design Notes

## 1. What issues did you find?

- **Transfer & Withdrawal Race Conditions** ✅ *(fixed)*: `transfer()` and `withdraw()` originally relied on read-modify-write patterns (`findById` → update in JavaScript → `.save()`) without atomic operators or database locks. Under concurrent operations, this allowed balances to drop below zero and caused lost updates. Fixed by replacing manual mutations with atomic `$inc` updates guarded by `{ balance: { $gte: amount } }`.
- **MongoDB Transaction Deadlocks** ✅ *(fixed)*: Simultaneous bidirectional transfers between two wallets (e.g. A → B and B → A) caused database deadlocks. Fixed by enforcing a deterministic lock acquisition sequence (`[fromId, toId].sort()`) prior to executing transaction operations.
- **Transfer Idempotency & Duplicate Side Effects** ✅ *(fixed)*: Lack of unique constraints on `idempotencyKey` allowed duplicate transfers to execute. Fixed by adding a unique sparse index on `Transfer.idempotencyKey` and gracefully returning existing records on collision.
- **Consumer Overwrites & Redelivery Duplication** ✅ *(fixed)*: RabbitMQ consumer credited recipient wallets using manual JS math and lacked atomicity. Redelivered messages could credit accounts multiple times. Fixed using atomic `$inc` operations and atomic status updates (`status: PENDING` → `COMPLETED`).
- **Poison Pill Loop in Event Consumer** ✅ *(fixed)*: The RabbitMQ message handler blindly requeued all errors (`nack(..., true)`), creating infinite processing loops for malformed or unresolvable payloads. Fixed by distinguishing unrecoverable structural errors (nacked without requeue) from transient infrastructure failures.
- **Double-Refund Race Condition** ✅ *(fixed)*: The pending transfer cleanup worker loaded stale transfers into memory without locking them, enabling horizontally scaled instances to refund the same failed transfer multiple times. Fixed by using an atomic state transition (`status: PENDING` → `FAILED`) as a pessimistic lock before executing refunds.
- **Memory Leaks & Unbounded Event Listeners** ✅ *(fixed)*: `WalletEventsWorker` registered persistent listeners on every tick without cleanup and suppressed Node leak warnings with `setMaxListeners(0)`. Fixed by replacing polling loops with native MongoDB Change Streams and Redis Pub/Sub event broadcasting.
- **Cache Stale Reads & Out-of-Sync Balance** ✅ *(fixed)*: State-modifying operations (`deposit`, `withdraw`, consumer credit) did not update or invalidate Redis cached balances, leading to stale balance responses on `GET /wallets/:id`. Fixed by updating/invalidating Redis entries inside transactional execution flow.
- **Un-wrapped Deposit Operations** ✅ *(fixed)*: `deposit()` performed wallet updates, transaction creation, and ledger logging as three disconnected operations without session transaction boundaries. Fixed by wrapping the entire deposit sequence in `session.withTransaction()`.
- **Dashboard N+1 Query & In-Memory Bloat** ✅ *(fixed)*: The wallet dashboard fetched complete transaction histories into application memory and executed individual ledger queries per transaction. Fixed by converting calculation paths to MongoDB aggregations and limiting recent activity fetches.
- **Missing Schema & Query Indexes** ✅ *(fixed)*: Core queries on `ledger_entries`, `transfers`, and `transactions` lacked supporting indexes, causing full collection scans as data volume expanded. Fixed by adding indexes for `{ _id: 1, status: 1 }`, `{ status: 1, createdAt: -1 }`, `{ walletId: 1, createdAt: -1 }`, and ledger lookups.
- **NestJS Dependency Injection Missing Providers** ✅ *(fixed)*: `WorkersModule` was missing registrations for `Transaction` model and `LedgerModule`, causing NestJS runtime startup dependency resolution crashes. Fixed by registering `TransactionSchema` and importing `LedgerModule` into `WorkersModule`.
- **Correlation ID Context Drop** ✅ *(fixed)*: Request correlation IDs were restricted to Express middleware and did not flow to outbox events, RabbitMQ messages, or consumer logs. Fixed by propagating correlation IDs across HTTP interceptors, exceptions, outbox entries, and message headers.

## 2. What did you prioritize, and why?

1. **Financial Accuracy & Data Integrity (Highest)**: Resolved negative balance race conditions, database deadlocks, double-refunds, and missing deposit transaction boundaries. Preventing monetary discrepancies and lost ledger updates is critical.
2. **NestJS Boot & Service Stability (High)**: Resolved NestJS DI registration failures, memory leaks in event workers, and RabbitMQ poison pill loops to ensure the application starts up reliably and avoids OOM or queue stall outages.
3. **Cache & Read Consistency (Medium)**: Ensured Redis cache operations strictly align with database transaction states to prevent stale balance reads.
4. **Performance & Indexing (Medium)**: Replaced unindexed full-collection scans and N+1 memory loading with MongoDB aggregations and schema indexes.

## 3. How did you handle concurrency?

- **Deterministic Locking**: Deadlocks during cross-wallet transfers are prevented by sorting wallet ObjectIDs alphabetically prior to acquiring document locks in MongoDB sessions.
- **Atomic Database Operations**: Replaced read-modify-write patterns with atomic `$inc` operators and conditional filters (`balance: { $gte: amount }`) to guarantee balance invariants at the database level.
- **Consumer State Guards**: Event consumption uses atomic `findOneAndUpdate` state transitions (`PENDING` → `COMPLETED`) so duplicate RabbitMQ message deliveries are safely ignored.
- **Worker Lock Transitions**: The pending transfer sweeper claims transfers atomically via `PENDING` → `FAILED` state transitions before issuing sender refunds, preventing multi-instance double refunds.

## 4. How did you ensure data consistency?

- **Transactional Outbox & Operations**: Money movements, ledger recordings, transaction history creation, and event outbox enqueues are executed within MongoDB `session.withTransaction()` boundaries to guarantee atomicity.
- **Cache Synchronization**: Balance updates are reflected in Redis within the transactional lifecycle to prevent cache pollution and stale read windows.
- **Error Classification**: Queue handlers inspect error types to reject unrecoverable malformed payloads while preserving transient infrastructure retries.

## 5. Trade-offs

- **Synchronous Redis Updates**: Performing Redis cache updates within transaction logic introduces minor network overhead during writes, prioritized over eventual consistency to guarantee immediate read-after-write accuracy.
- **Outbox Relay Latency**: Staging events to an outbox table before broker dispatch adds slight delivery latency (~polling interval), traded off against direct publishing to eliminate lost or duplicated event side-effects.

## 6. Remaining technical debt

- **Strict Value Validation**: Ensure all monetary inputs are validated as positive integer minor units (cents) to avoid floating-point representation artifacts.
- **Dead Letter Queue (DLQ) Setup**: Extend RabbitMQ topology with explicit DLQ exchanges to retain dropped poison-pill messages for manual inspection.

## 7. What would you improve with another day?

- **Formal DLQ Pipeline**: Implement full Dead Letter Queues and admin re-queue tooling for failed domain events.
- **Distributed Leader Election for Cron Workers**: Add distributed locks (e.g. Redlock or Mongo-based leader election) to guarantee single-worker execution across horizontally scaled pods.
- **Automated Reconciliation**: Schedule background worker checks against `LedgerService.aggregateNetByWallet()` to automatically flag any balance discrepancies.

## 8. Assumptions

- **MongoDB Replica Set**: Multi-document transactions require MongoDB to run in a replica set configuration (`rs0`).
- **Containerized Stack**: Services interact over Docker container networking (`mongo`, `redis`, `rabbitmq`).
