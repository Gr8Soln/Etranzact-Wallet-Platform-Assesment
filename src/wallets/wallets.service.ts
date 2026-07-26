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
        // Atomic update without redundant version increment
        wallet = (await this.walletModel.findByIdAndUpdate(
          id,
          { $inc: { balance: dto.amount } },
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
        // Cache update INSIDE the transaction boundary to prevent stale reads
        await this.redisService.setCachedBalance(id, wallet.balance);
      });

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
        // Atomic update with $gte check, no redundant version tracking
        wallet = (await this.walletModel.findOneAndUpdate(
          { _id: id, balance: { $gte: dto.amount } },
          { $inc: { balance: -dto.amount } },
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
        // Cache update INSIDE the transaction boundary
        await this.redisService.setCachedBalance(id, wallet.balance);
      });

      return wallet;
    } finally {
      await session.endSession();
    }
  }

  async transfer(dto: TransferDto) {
    if (dto.fromWalletId === dto.toWalletId) {
      throw new BadRequestException('Cannot transfer to the same wallet');
    }

    // Idempotency is now enforced by a unique index on the schema

    const session = await this.connection.startSession();
    let transfer!: TransferDocument;

    try {
      await session.withTransaction(async () => {
        // Deadlock Prevention: Order wallet IDs to enforce a strict locking hierarchy
        const sortedIds = [dto.fromWalletId, dto.toWalletId].sort();
        
        // Lock both wallets in alphabetical order to prevent cross-locks
        await this.walletModel.find({ _id: { $in: sortedIds } }).session(session);

        // Now safely perform atomic debit with constraint
        const fromWallet = await this.walletModel.findOneAndUpdate(
          { _id: dto.fromWalletId, balance: { $gte: dto.amount } },
          { $inc: { balance: -dto.amount } },
          { new: true, session },
        );
        const toWallet = await this.walletModel.findById(dto.toWalletId, null, { session });

        if (!toWallet) {
          throw new NotFoundException('Destination wallet not found');
        }
        if (!fromWallet) {
          const exists = await this.walletModel.findById(dto.fromWalletId, null, { session });
          if (!exists) throw new NotFoundException('Source wallet not found');
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
        // Update cache strictly inside transaction boundary
        await this.redisService.setCachedBalance(dto.fromWalletId, fromWallet.balance);
      });
    } catch (error: any) {
      if (error.code === 11000 && dto.idempotencyKey) {
        // Return existing transfer gracefully on duplicate key race
        const existing = await this.transferModel.findOne({ idempotencyKey: dto.idempotencyKey });
        if (existing) return existing;
      }
      throw error;
    } finally {
      await session.endSession();
    }

    return transfer;
  }

  async getDashboard(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    // Optimize performance by calculating totals via MongoDB aggregation instead of in-memory
    const [stats] = await this.transactionModel.aggregate([
      { $match: { walletId: wallet._id } },
      {
        $group: {
          _id: null,
          totalDeposited: {
            $sum: {
              $cond: [{ $in: ['$type', [TransactionType.DEPOSIT, TransactionType.TRANSFER_IN]] }, '$amount', 0],
            },
          },
          totalWithdrawn: {
            $sum: {
              $cond: [{ $in: ['$type', [TransactionType.WITHDRAWAL, TransactionType.TRANSFER_OUT]] }, '$amount', 0],
            },
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const recentTxns = await this.transactionModel.find({ walletId: id }).sort({ createdAt: -1 }).limit(10).exec();
    const recentTxnIds = recentTxns.map((t) => t._id);
    const recentEntries = await this.ledgerEntryModel.find({ transactionId: { $in: recentTxnIds } }).exec();

    const entriesByTxnId = new Map<string, LedgerEntryDocument[]>();
    for (const entry of recentEntries) {
      const key = entry.transactionId.toString();
      if (!entriesByTxnId.has(key)) entriesByTxnId.set(key, []);
      entriesByTxnId.get(key)!.push(entry);
    }

    const recentActivity = recentTxns.map((transaction) => ({
      transaction,
      entries: entriesByTxnId.get(transaction._id.toString()) ?? [],
    }));

    return {
      wallet,
      totalDeposited: stats?.totalDeposited ?? 0,
      totalWithdrawn: stats?.totalWithdrawn ?? 0,
      transactionCount: stats?.count ?? 0,
      recentActivity,
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
