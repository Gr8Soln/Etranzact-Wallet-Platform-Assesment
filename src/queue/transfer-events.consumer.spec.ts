import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import { Transaction, TransactionType } from '../transactions/schemas/transaction.schema';
import { Transfer, TransferStatus } from '../wallets/schemas/transfer.schema';
import { Wallet } from '../wallets/schemas/wallet.schema';
import { RabbitMQService } from './rabbitmq.service';
import { TransferEventsConsumer } from './transfer-events.consumer';

describe('TransferEventsConsumer', () => {
  let consumer: TransferEventsConsumer;
  let transferModel: any;
  let walletModel: any;
  let transactionModel: any;
  let ledgerService: any;

  beforeEach(async () => {
    transferModel = { findById: jest.fn() };
    walletModel = { findById: jest.fn() };
    transactionModel = { create: jest.fn() };
    ledgerService = { recordCredit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferEventsConsumer,
        {
          provide: RabbitMQService,
          useValue: { getChannelWrapper: jest.fn(), getTransferQueue: jest.fn() },
        },
        { provide: getModelToken(Transfer.name), useValue: transferModel },
        { provide: getModelToken(Wallet.name), useValue: walletModel },
        { provide: getModelToken(Transaction.name), useValue: transactionModel },
        { provide: LedgerService, useValue: ledgerService },
        { provide: RedisService, useValue: { invalidateBalance: jest.fn() } },
      ],
    }).compile();

    consumer = module.get(TransferEventsConsumer);
  });

  it('skips processing when the transfer is already completed (idempotency guard)', async () => {
    const transfer = {
      _id: new Types.ObjectId(),
      id: 'transfer-1',
      status: TransferStatus.COMPLETED,
    };
    transferModel.findById.mockResolvedValue(transfer);

    await (consumer as any).completeTransfer({
      transferId: transfer._id.toString(),
      fromWalletId: 'wallet-1',
      toWalletId: 'wallet-2',
      amount: 25,
    });

    expect(walletModel.findById).not.toHaveBeenCalled();
    expect(transactionModel.create).not.toHaveBeenCalled();
  });

  it('credits the destination wallet and marks the transfer completed', async () => {
    const transfer = {
      _id: new Types.ObjectId(),
      id: 'transfer-1',
      save: jest.fn(),
      status: TransferStatus.PENDING,
    };
    const toWallet = { _id: new Types.ObjectId(), id: 'wallet-2', balance: 100, save: jest.fn() };
    transferModel.findById.mockResolvedValue(transfer);
    walletModel.findById.mockResolvedValue(toWallet);
    const creditTransaction = { _id: new Types.ObjectId() };
    transactionModel.create.mockResolvedValue([creditTransaction]);

    await (consumer as any).completeTransfer({
      transferId: transfer._id.toString(),
      fromWalletId: 'wallet-1',
      toWalletId: toWallet._id.toString(),
      amount: 25,
    });

    expect(toWallet.balance).toBe(125);
    expect(toWallet.save).toHaveBeenCalled();
    expect(transactionModel.create).toHaveBeenCalledWith([
      expect.objectContaining({ type: TransactionType.TRANSFER_IN, amount: 25, balanceAfter: 125 }),
    ]);
    expect(ledgerService.recordCredit).toHaveBeenCalledWith(
      toWallet._id,
      creditTransaction._id,
      25,
      125,
    );
    expect(transfer.status).toBe(TransferStatus.COMPLETED);
    expect(transfer.save).toHaveBeenCalled();
  });

  it('skips processing when the transfer no longer exists', async () => {
    transferModel.findById.mockResolvedValue(null);

    await (consumer as any).completeTransfer({
      transferId: 'missing',
      fromWalletId: 'wallet-1',
      toWalletId: 'wallet-2',
      amount: 25,
    });

    expect(walletModel.findById).not.toHaveBeenCalled();
  });
});
