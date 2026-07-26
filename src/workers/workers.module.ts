import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { QueueModule } from '../queue/queue.module';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import { Transfer, TransferSchema } from '../wallets/schemas/transfer.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import { OutboxRelayWorker } from './outbox-relay.worker';
import { PendingTransferWorker } from './pending-transfer.worker';
import { WalletEventsWorker } from './wallet-events.worker';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transfer.name, schema: TransferSchema },
      { name: Wallet.name, schema: WalletSchema },
      { name: Transaction.name, schema: TransactionSchema },
    ]),
    LedgerModule,
    OutboxModule,
    QueueModule,
  ],
  providers: [OutboxRelayWorker, PendingTransferWorker, WalletEventsWorker],
})
export class WorkersModule {}
