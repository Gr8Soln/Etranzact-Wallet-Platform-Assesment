import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConsumeMessage } from 'amqplib';
import { Connection, Model } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import { Transaction, TransactionDocument, TransactionStatus, TransactionType } from '../transactions/schemas/transaction.schema';
import { Transfer, TransferDocument, TransferStatus } from '../wallets/schemas/transfer.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { RabbitMQService } from './rabbitmq.service';

export interface TransferInitiatedEvent {
  transferId: string;
  fromWalletId: string;
  toWalletId: string;
  amount: number;
}

@Injectable()
export class TransferEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(TransferEventsConsumer.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly rabbitMQService: RabbitMQService,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    private readonly ledgerService: LedgerService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    const channelWrapper = this.rabbitMQService.getChannelWrapper();
    const queue = this.rabbitMQService.getTransferQueue();
    channelWrapper.addSetup((channel) =>
      channel.consume(queue, (message) => this.handleMessage(message, channel)),
    );
  }

  private async handleMessage(message: ConsumeMessage | null, channel: any) {
    if (!message) return;

    try {
      const event: TransferInitiatedEvent = JSON.parse(message.content.toString());
      await this.completeTransfer(event);
      channel.ack(message);
    } catch (error: any) {
      this.logger.error(`Failed to process transfer event: ${error.message}`);
      
      // Poison Pill Prevention: Do not requeue fatal structural errors
      const isFatal = error instanceof SyntaxError || error.message.includes('not found') || error.message.includes('Validation');
      
      if (isFatal) {
        this.logger.error(`Fatal error detected, dropping message to prevent infinite loop.`);
        channel.nack(message, false, false);
      } else {
        // Only requeue transient/network/DB locking errors
        channel.nack(message, false, true);
      }
    }
  }

  private async completeTransfer(event: TransferInitiatedEvent) {
    const session = await this.connection.startSession();
    let isAlreadyCompleted = false;
    let notFound = false;

    try {
      await session.withTransaction(async () => {
        const transfer = await this.transferModel.findOneAndUpdate(
          { _id: event.transferId, status: TransferStatus.PENDING },
          { status: TransferStatus.COMPLETED },
          { new: true, session },
        );

        if (!transfer) {
          const exists = await this.transferModel.findById(event.transferId, null, { session });
          if (!exists) notFound = true;
          else isAlreadyCompleted = true;
          return;
        }

        // Destructive overwrite fixed: Use atomic $inc inside the database
        const toWallet = await this.walletModel.findOneAndUpdate(
          { _id: event.toWalletId },
          { $inc: { balance: event.amount } },
          { new: true, session }
        );

        if (!toWallet) {
          throw new Error(`Destination wallet ${event.toWalletId} not found`);
        }

        const [creditTransaction] = await this.transactionModel.create([{
          walletId: toWallet._id,
          type: TransactionType.TRANSFER_IN,
          amount: event.amount,
          status: TransactionStatus.COMPLETED,
          balanceAfter: toWallet.balance,
          transferId: transfer._id,
          counterpartyWalletId: transfer.fromWalletId,
        }], { session });

        await this.ledgerService.recordCredit(toWallet._id, creditTransaction._id, event.amount, toWallet.balance, session);

        // Cache update securely INSIDE the transactional boundary
        await this.redisService.setCachedBalance(event.toWalletId, toWallet.balance);
      });
    } finally {
      await session.endSession();
    }

    if (notFound) this.logger.warn(`Transfer ${event.transferId} not found, skipping`);
    if (isAlreadyCompleted) this.logger.warn(`Transfer ${event.transferId} already completed, skipping (idempotent)`);
    if (!notFound && !isAlreadyCompleted) this.logger.log(`Transfer ${event.transferId} completed for wallet ${event.toWalletId}`);
  }
}
