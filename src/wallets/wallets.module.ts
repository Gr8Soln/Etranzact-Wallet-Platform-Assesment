import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerModule } from '../ledger/ledger.module';
import { LedgerEntry, LedgerEntrySchema } from '../ledger/schemas/ledger-entry.schema';
import { OutboxModule } from '../outbox/outbox.module';
import { QueueModule } from '../queue/queue.module';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import { TransactionsModule } from '../transactions/transactions.module';
import { Transfer, TransferSchema } from './schemas/transfer.schema';
import { Wallet, WalletSchema } from './schemas/wallet.schema';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { WalletOwnerGuard } from './guards/wallet-owner.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Wallet.name, schema: WalletSchema },
      { name: Transfer.name, schema: TransferSchema },
      { name: Transaction.name, schema: TransactionSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
    LedgerModule,
    OutboxModule,
    QueueModule,
    TransactionsModule,
  ],
  controllers: [WalletsController],
  providers: [WalletsService, WalletOwnerGuard],
  exports: [WalletsService],
})
export class WalletsModule {}
