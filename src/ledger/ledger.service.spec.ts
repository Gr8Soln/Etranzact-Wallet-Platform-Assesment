import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { LedgerEntry, LedgerEntryDirection } from './schemas/ledger-entry.schema';
import { LedgerService } from './ledger.service';

describe('LedgerService', () => {
  let service: LedgerService;
  let ledgerEntryModel: any;

  beforeEach(async () => {
    ledgerEntryModel = {
      create: jest.fn(),
      find: jest.fn(),
      aggregate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        { provide: getModelToken(LedgerEntry.name), useValue: ledgerEntryModel },
      ],
    }).compile();

    service = module.get(LedgerService);
  });

  it('records a debit entry with the correct direction', async () => {
    const walletId = new Types.ObjectId();
    const transactionId = new Types.ObjectId();
    ledgerEntryModel.create.mockResolvedValue([{ _id: new Types.ObjectId() }]);

    await service.recordDebit(walletId, transactionId, 50, 450);

    expect(ledgerEntryModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          walletId,
          transactionId,
          direction: LedgerEntryDirection.DEBIT,
          amount: 50,
          balanceAfter: 450,
        }),
      ],
      undefined,
    );
  });

  it('records a credit entry with the correct direction', async () => {
    const walletId = new Types.ObjectId();
    const transactionId = new Types.ObjectId();
    ledgerEntryModel.create.mockResolvedValue([{ _id: new Types.ObjectId() }]);

    await service.recordCredit(walletId, transactionId, 100, 600);

    expect(ledgerEntryModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          direction: LedgerEntryDirection.CREDIT,
          amount: 100,
          balanceAfter: 600,
        }),
      ],
      undefined,
    );
  });

  it('computes the net balance from a mix of debit and credit entries', async () => {
    ledgerEntryModel.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue([
        { direction: LedgerEntryDirection.CREDIT, amount: 500 },
        { direction: LedgerEntryDirection.DEBIT, amount: 120 },
        { direction: LedgerEntryDirection.CREDIT, amount: 30 },
      ]),
    });

    const balance = await service.computeBalanceFromLedger('wallet-1');

    expect(balance).toBe(410);
  });

  it('fetches paginated audit trail entries', async () => {
    const items = [{ id: '1' }, { id: '2' }];
    const execMock = jest.fn().mockResolvedValue(items);
    ledgerEntryModel.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      exec: execMock,
    });
    ledgerEntryModel.countDocuments = jest.fn().mockResolvedValue(2);

    const result = await service.getAuditTrail('wallet-1', 1, 10, LedgerEntryDirection.CREDIT);

    expect(result).toEqual({ items, total: 2, page: 1, limit: 10 });
  });
});
