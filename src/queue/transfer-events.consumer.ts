import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConsumeMessage } from 'amqplib';
import { Connection, Model } from 'mongoose';

import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import {
  Transaction,
  TransactionDocument,
  TransactionStatus,
  TransactionType,
} from '../transactions/schemas/transaction.schema';
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
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
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
    if (!message) {
      return;
    }

    try {
      const event: TransferInitiatedEvent = JSON.parse(message.content.toString());
      await this.completeTransfer(event);
      channel.ack(message);
    } catch (error) {
      this.logger.error(`Failed to process transfer event: ${(error as Error).message}`);
      // Requeue failed messages to prevent message loss
      channel.nack(message, false, true);
    }
  }

  private async completeTransfer(event: TransferInitiatedEvent) {
    const session = await this.connection.startSession();
    let isAlreadyCompleted = false;
    let notFound = false;
    let transferId = event.transferId;

    try {
      await session.withTransaction(async () => {
        // Idempotency: atomically transition to COMPLETED to prevent duplicate credits
        const transfer = await this.transferModel.findOneAndUpdate(
          { _id: transferId, status: TransferStatus.PENDING },
          { status: TransferStatus.COMPLETED },
          { new: true, session },
        );

        if (!transfer) {
          const exists = await this.transferModel.findById(transferId, null, { session });
          if (!exists) notFound = true;
          else isAlreadyCompleted = true;
          return;
        }

        const toWallet = await this.walletModel.findById(event.toWalletId, null, { session });
        if (!toWallet) {
          throw new Error(`Destination wallet ${event.toWalletId} not found`);
        }

        toWallet.balance += event.amount;
        toWallet.version += 1;
        await toWallet.save({ session });

        const [creditTransaction] = await this.transactionModel.create(
          [
            {
              walletId: toWallet._id,
              type: TransactionType.TRANSFER_IN,
              amount: event.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: toWallet.balance,
              transferId: transfer._id,
              counterpartyWalletId: transfer.fromWalletId,
            },
          ],
          { session },
        );

        await this.ledgerService.recordCredit(
          toWallet._id,
          creditTransaction._id,
          event.amount,
          toWallet.balance,
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    if (notFound) {
      this.logger.warn(`Transfer ${transferId} not found, skipping`);
      return;
    }

    if (isAlreadyCompleted) {
      this.logger.warn(`Transfer ${transferId} already completed, skipping (idempotent)`);
      return;
    }

    await this.redisService.invalidateBalance(event.toWalletId);

    this.logger.log(`Transfer ${transferId} completed for wallet ${event.toWalletId}`);
  }
}
