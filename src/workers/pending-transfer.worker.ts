import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection } from 'mongoose';
import { Transfer, TransferDocument, TransferStatus } from '../wallets/schemas/transfer.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { Transaction, TransactionDocument, TransactionType, TransactionStatus } from '../transactions/schemas/transaction.schema';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class PendingTransferWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingTransferWorker.name);
  private timer: NodeJS.Timeout;

  constructor(
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    private readonly ledgerService: LedgerService,
    @InjectConnection() private readonly connection: Connection,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    const intervalMs = this.configService.getOrThrow<number>('workers.pendingTransferSweepIntervalMs');
    this.timer = setInterval(() => this.sweep(), intervalMs);
  }

  private async sweep() {
    const timeoutMs = this.configService.getOrThrow<number>('workers.pendingTransferTimeoutMs');
    const cutoff = new Date(Date.now() - timeoutMs);

    // Fetch raw stale IDs only to minimize memory overhead
    const staleTransfers = await this.transferModel
      .find({ status: TransferStatus.PENDING, createdAt: { $lt: cutoff } })
      .select('_id fromWalletId amount')
      .lean()
      .exec();

    for (const stale of staleTransfers) {
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(async () => {
          // Atomic State Lock: Claim the transfer before doing ANY refund logic
          // This prevents Double-Refund race conditions across horizontal instances
          const lockedTransfer = await this.transferModel.findOneAndUpdate(
            { _id: stale._id, status: TransferStatus.PENDING },
            { 
              status: TransferStatus.FAILED, 
              failureReason: `Transfer timed out after ${timeoutMs}ms in PENDING state` 
            },
            { new: true, session }
          );

          if (!lockedTransfer) return; // Another server instance already claimed/refunded this

          // Refund the original sender atomically
          const wallet = await this.walletModel.findOneAndUpdate(
            { _id: lockedTransfer.fromWalletId },
            { $inc: { balance: lockedTransfer.amount } },
            { new: true, session },
          );

          if (wallet) {
            const [refundTxn] = await this.transactionModel.create([{
              walletId: wallet._id,
              type: TransactionType.TRANSFER_IN,
              amount: lockedTransfer.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: wallet.balance,
              transferId: lockedTransfer._id,
              reference: `REFUND-${lockedTransfer._id}`
            }], { session });

            await this.ledgerService.recordCredit(wallet._id, refundTxn._id, lockedTransfer.amount, wallet.balance, session);
          }
        });
        this.logger.warn(`Marked transfer ${stale._id} as FAILED and refunded sender`);
      } catch (err) {
        this.logger.error(`Failed to refund transfer ${stale._id}: ${(err as Error).message}`);
      } finally {
        await session.endSession();
      }
    }
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }
}
