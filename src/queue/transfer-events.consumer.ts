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
      channel.nack(message, false, false);
    }
  }

  private async completeTransfer(event: TransferInitiatedEvent) {
    const transfer = await this.transferModel.findById(event.transferId);
    if (!transfer) {
      this.logger.warn(`Transfer ${event.transferId} not found, skipping`);
      return;
    }

    if (transfer.status === TransferStatus.COMPLETED) {
      this.logger.warn(`Transfer ${event.transferId} already completed, skipping (idempotent)`);
      return;
    }

    const session = await this.connection.startSession();

    try {
      await session.withTransaction(async () => {
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

        transfer.status = TransferStatus.COMPLETED;
        await transfer.save({ session });
      });
    } finally {
      await session.endSession();
    }

    await this.redisService.invalidateBalance(event.toWalletId);

    this.logger.log(`Transfer ${transfer.id} completed for wallet ${event.toWalletId}`);
  }
}
