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
    const intervalMs = this.configService.getOrThrow<number>(
      'workers.pendingTransferSweepIntervalMs',
    );
    this.timer = setInterval(() => this.sweep(), intervalMs);
  }

  private async sweep() {
    const timeoutMs = this.configService.getOrThrow<number>('workers.pendingTransferTimeoutMs');
    const cutoff = new Date(Date.now() - timeoutMs);

    const stale = await this.transferModel
      .find({ status: TransferStatus.PENDING, createdAt: { $lt: cutoff } })
      .exec();

    for (const transfer of stale) {
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(async () => {
          // Refund the original sender
          const wallet = await this.walletModel.findOneAndUpdate(
            { _id: transfer.fromWalletId },
            { $inc: { balance: transfer.amount, version: 1 } },
            { new: true, session },
          );
          if (wallet) {
            const [refundTxn] = await this.transactionModel.create([{
              walletId: wallet._id,
              type: TransactionType.TRANSFER_IN,
              amount: transfer.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: wallet.balance,
              transferId: transfer._id,
              reference: `REFUND-${transfer._id}`
            }], { session });
            await this.ledgerService.recordCredit(wallet._id, refundTxn._id, transfer.amount, wallet.balance, session);
          }
          transfer.status = TransferStatus.FAILED;
          transfer.failureReason = `Transfer timed out after ${timeoutMs}ms in PENDING state`;
          await transfer.save({ session });
        });
        this.logger.warn(`Marked transfer ${transfer.id} as FAILED and refunded sender`);
      } catch (err) {
        this.logger.error(`Failed to refund transfer ${transfer.id}: ${(err as Error).message}`);
      } finally {
        await session.endSession();
      }
    }
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }
}
