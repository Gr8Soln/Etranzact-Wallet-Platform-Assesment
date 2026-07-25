import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { LedgerEntry, LedgerEntryDocument } from '../ledger/schemas/ledger-entry.schema';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { RabbitMQService } from '../queue/rabbitmq.service';
import { RedisService } from '../redis/redis.service';
import { TransactionsService } from '../transactions/transactions.service';
import {
  Transaction,
  TransactionDocument,
  TransactionStatus,
  TransactionType,
} from '../transactions/schemas/transaction.schema';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { Transfer, TransferDocument, TransferStatus } from './schemas/transfer.schema';
import { Wallet, WalletDocument } from './schemas/wallet.schema';

@Injectable()
export class WalletsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntryDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly ledgerService: LedgerService,
    private readonly outboxService: OutboxService,
    private readonly rabbitMQService: RabbitMQService,
    private readonly redisService: RedisService,
  ) {}

  async createWallet(dto: CreateWalletDto) {
    const session = await this.connection.startSession();
    let wallet!: WalletDocument;

    try {
      await session.withTransaction(async () => {
        [wallet] = await this.walletModel.create(
          [
            {
              userId: dto.userId,
              ownerName: dto.ownerName,
              currency: dto.currency ?? 'GHS',
              balance: 0,
            },
          ],
          { session },
        );

        await this.outboxService.enqueue(
          'wallet.created',
          {
            walletId: wallet._id.toString(),
            userId: wallet.userId,
            currency: wallet.currency,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    return wallet;
  }

  async getWallet(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const cachedBalance = await this.redisService.getCachedBalance(id);
    if (cachedBalance !== null) {
      return { ...wallet.toObject(), balance: cachedBalance };
    }

    await this.redisService.setCachedBalance(id, wallet.balance);
    return wallet;
  }

  async deposit(id: string, dto: DepositDto) {
    const session = await this.connection.startSession();

    try {
      let wallet!: WalletDocument;
      let transaction!: TransactionDocument;

      await session.withTransaction(async () => {
        wallet = (await this.walletModel.findByIdAndUpdate(
          id,
          { $inc: { balance: dto.amount, version: 1 } },
          { new: true, session },
        ))!;

        if (!wallet) {
          throw new NotFoundException(`Wallet ${id} not found`);
        }

        transaction = await this.transactionsService.create({
          walletId: wallet.id,
          type: TransactionType.DEPOSIT,
          amount: dto.amount,
          balanceAfter: wallet.balance,
          reference: dto.reference,
        }, session);

        await this.ledgerService.recordCredit(
          wallet._id, transaction._id, dto.amount, wallet.balance, session,
        );

        await this.outboxService.enqueue('wallet.deposited', {
          walletId: wallet.id,
          transactionId: transaction.id,
          amount: dto.amount,
          balanceAfter: wallet.balance,
        }, session);
      });

      await this.redisService.invalidateBalance(id);

      return wallet;
    } finally {
      await session.endSession();
    }
  }

  async withdraw(id: string, dto: WithdrawDto) {
    const session = await this.connection.startSession();

    try {
      let wallet!: WalletDocument;
      let transaction!: TransactionDocument;

      await session.withTransaction(async () => {
        wallet = (await this.walletModel.findOneAndUpdate(
          { _id: id, balance: { $gte: dto.amount } },
          { $inc: { balance: -dto.amount, version: 1 } },
          { new: true, session },
        ))!;

        if (!wallet) {
          const exists = await this.walletModel.findById(id, null, { session });
          if (!exists) {
            throw new NotFoundException(`Wallet ${id} not found`);
          }
          throw new BadRequestException('Insufficient balance');
        }

        transaction = await this.transactionsService.create({
          walletId: wallet.id,
          type: TransactionType.WITHDRAWAL,
          amount: dto.amount,
          balanceAfter: wallet.balance,
          reference: dto.reference,
        }, session);

        await this.ledgerService.recordDebit(
          wallet._id, transaction._id, dto.amount, wallet.balance, session,
        );

        await this.outboxService.enqueue('wallet.withdrawn', {
          walletId: wallet.id,
          transactionId: transaction.id,
          amount: dto.amount,
          balanceAfter: wallet.balance,
        }, session);
      });

      await this.redisService.invalidateBalance(id);

      return wallet;
    } finally {
      await session.endSession();
    }
  }

  async transfer(dto: TransferDto) {
    if (dto.fromWalletId === dto.toWalletId) {
      throw new BadRequestException('Cannot transfer to the same wallet');
    }

    if (dto.idempotencyKey) {
      const existing = await this.transferModel.findOne({ idempotencyKey: dto.idempotencyKey });
      if (existing) {
        return existing;
      }
    }

    const session = await this.connection.startSession();
    let transfer!: TransferDocument;

    try {
      await session.withTransaction(async () => {
        const [fromWallet, toWallet] = await Promise.all([
          this.walletModel.findById(dto.fromWalletId, null, { session }),
          this.walletModel.findById(dto.toWalletId, null, { session }),
        ]);

        if (!fromWallet || !toWallet) {
          throw new NotFoundException('Wallet not found');
        }

        if (fromWallet.balance < dto.amount) {
          throw new BadRequestException('Insufficient balance');
        }

        [transfer] = await this.transferModel.create(
          [
            {
              fromWalletId: fromWallet._id,
              toWalletId: toWallet._id,
              amount: dto.amount,
              status: TransferStatus.PENDING,
              idempotencyKey: dto.idempotencyKey,
            },
          ],
          { session },
        );

        fromWallet.balance -= dto.amount;
        fromWallet.version += 1;
        await fromWallet.save({ session });

        const [debitTransaction] = await this.transactionModel.create(
          [
            {
              walletId: fromWallet._id,
              type: TransactionType.TRANSFER_OUT,
              amount: dto.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: fromWallet.balance,
              transferId: transfer._id,
              counterpartyWalletId: toWallet._id,
            },
          ],
          { session },
        );

        await this.ledgerService.recordDebit(
          fromWallet._id,
          debitTransaction._id,
          dto.amount,
          fromWallet.balance,
          session,
        );

        await this.outboxService.enqueue(
          'transfer.initiated',
          {
            transferId: transfer._id.toString(),
            fromWalletId: fromWallet._id.toString(),
            toWalletId: toWallet._id.toString(),
            amount: dto.amount,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    await this.redisService.invalidateBalance(dto.fromWalletId);

    return transfer;
  }

  async getDashboard(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const transactions = await this.transactionModel
      .find({ walletId: id })
      .sort({ createdAt: -1 })
      .exec();

    const txnIds = transactions.map((t) => t._id);
    const allEntries = await this.ledgerEntryModel
      .find({ transactionId: { $in: txnIds } })
      .exec();

    const entriesByTxnId = new Map<string, LedgerEntryDocument[]>();
    for (const entry of allEntries) {
      const key = entry.transactionId.toString();
      if (!entriesByTxnId.has(key)) {
        entriesByTxnId.set(key, []);
      }
      entriesByTxnId.get(key)!.push(entry);
    }

    let totalDeposited = 0;
    let totalWithdrawn = 0;
    const recentActivity: Array<{
      transaction: TransactionDocument;
      entries: LedgerEntryDocument[];
    }> = [];

    for (const txn of transactions) {
      const entries = entriesByTxnId.get(txn._id.toString()) ?? [];

      if (txn.type === TransactionType.DEPOSIT || txn.type === TransactionType.TRANSFER_IN) {
        totalDeposited += txn.amount;
      } else {
        totalWithdrawn += txn.amount;
      }

      recentActivity.push({ transaction: txn, entries });
    }

    return {
      wallet,
      totalDeposited,
      totalWithdrawn,
      transactionCount: transactions.length,
      recentActivity: recentActivity.slice(0, 10),
    };
  }

  async reconcile(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const computedBalance = await this.ledgerService.aggregateNetByWallet(id);

    return {
      walletId: wallet._id.toString(),
      recordedBalance: wallet.balance,
      computedBalance,
      difference: computedBalance - wallet.balance,
      inSync: computedBalance === wallet.balance,
    };
  }
}
