import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  LedgerEntry,
  LedgerEntryDirection,
  LedgerEntryDocument,
} from './schemas/ledger-entry.schema';

@Injectable()
export class LedgerService {
  constructor(
    @InjectModel(LedgerEntry.name)
    private readonly ledgerEntryModel: Model<LedgerEntryDocument>,
  ) {}

  async recordDebit(
    walletId: Types.ObjectId | string,
    transactionId: Types.ObjectId | string,
    amount: number,
    balanceAfter: number,
    session?: ClientSession,
  ) {
    return this.createEntry(
      walletId,
      transactionId,
      LedgerEntryDirection.DEBIT,
      amount,
      balanceAfter,
      session,
    );
  }

  async recordCredit(
    walletId: Types.ObjectId | string,
    transactionId: Types.ObjectId | string,
    amount: number,
    balanceAfter: number,
    session?: ClientSession,
  ) {
    return this.createEntry(
      walletId,
      transactionId,
      LedgerEntryDirection.CREDIT,
      amount,
      balanceAfter,
      session,
    );
  }

  private async createEntry(
    walletId: Types.ObjectId | string,
    transactionId: Types.ObjectId | string,
    direction: LedgerEntryDirection,
    amount: number,
    balanceAfter: number,
    session?: ClientSession,
  ) {
    const [entry] = await this.ledgerEntryModel.create(
      [
        {
          walletId,
          transactionId,
          direction,
          amount,
          balanceAfter,
        },
      ],
      session ? { session } : undefined,
    );
    return entry;
  }

  async getEntriesForWallet(walletId: string) {
    return this.ledgerEntryModel.find({ walletId }).sort({ createdAt: 1 }).exec();
  }

  /**
   * Recomputes a wallet's balance strictly from its ledger entries. Used for
   * reconciliation against the denormalized Wallet.balance field.
   */
  async computeBalanceFromLedger(walletId: string): Promise<number> {
    const entries = await this.ledgerEntryModel.find({ walletId }).exec();
    return entries.reduce((total, entry) => {
      return entry.direction === LedgerEntryDirection.CREDIT
        ? total + entry.amount
        : total - entry.amount;
    }, 0);
  }

  async aggregateNetByWallet(walletId: string): Promise<number> {
    const [result] = await this.ledgerEntryModel.aggregate([
      { $match: { walletId: new Types.ObjectId(walletId) } },
      {
        $group: {
          _id: '$walletId',
          net: {
            $sum: {
              $cond: [
                { $eq: ['$direction', LedgerEntryDirection.CREDIT] },
                '$amount',
                { $multiply: ['$amount', -1] },
              ],
            },
          },
        },
      },
    ]);

    return result?.net ?? 0;
  }

  async getAuditTrail(
    walletId: string,
    page: number = 1,
    limit: number = 20,
    direction?: LedgerEntryDirection,
  ) {
    const filter: Record<string, unknown> = { walletId };
    if (direction) {
      filter.direction = direction;
    }

    const [items, total] = await Promise.all([
      this.ledgerEntryModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.ledgerEntryModel.countDocuments(filter),
    ]);

    return { items, total, page, limit };
  }
}
