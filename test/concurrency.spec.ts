import { INestApplication } from '@nestjs/common';
import { Connection } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

import { Transfer } from '../src/wallets/schemas/transfer.schema';
import { Wallet } from '../src/wallets/schemas/wallet.schema';
import {
  createAuthenticatedRequest,
  createTestApp,
  getModel,
  resetDatabase,
} from './integration/test-utils';

describe('Hidden Production-Readiness Tests', () => {
  let app: INestApplication;
  let connection: Connection;
  let client: Awaited<ReturnType<typeof createAuthenticatedRequest>>;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  beforeEach(async () => {
    await resetDatabase(connection);
    client = await createAuthenticatedRequest(app, connection);
  });

  afterAll(async () => {
    await app.close();
  });

  it('Hidden-01: Prevents Deadlocks in Bidirectional Transfers (A->B and B->A)', async () => {
    const walletA = await client
      .post('/wallets')
      .send({ userId: 'user-a', ownerName: 'Alice' })
      .expect(201);
    const walletB = await client
      .post('/wallets')
      .send({ userId: 'user-b', ownerName: 'Bob' })
      .expect(201);

    await client.post(`/wallets/${walletA.body._id}/deposit`).send({ amount: 1000 }).expect(201);
    await client.post(`/wallets/${walletB.body._id}/deposit`).send({ amount: 1000 }).expect(201);

    // Blast bidirectional transfers simultaneously to test for MongoDB cross-locking deadlocks
    const concurrency = 20;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < concurrency; i++) {
      promises.push(
        client.post('/wallets/transfer').send({
          fromWalletId: walletA.body._id,
          toWalletId: walletB.body._id,
          amount: 10,
          idempotencyKey: uuidv4(),
        }),
      );
      promises.push(
        client.post('/wallets/transfer').send({
          fromWalletId: walletB.body._id,
          toWalletId: walletA.body._id,
          amount: 10,
          idempotencyKey: uuidv4(),
        }),
      );
    }

    const results = await Promise.allSettled(promises);
    const failures = results.filter(
      (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status !== 201),
    );

    // There should be zero lock/abort errors
    expect(failures.length).toBe(0);

    const finalA = await getModel(app, Wallet.name).findById(walletA.body._id);
    const finalB = await getModel(app, Wallet.name).findById(walletB.body._id);

    // Since they sent equal amounts to each other, balances should remain identical
    expect(finalA?.balance).toBe(1000);
    expect(finalB?.balance).toBe(1000);
  });

  it('Hidden-02: Strictly enforces idempotency on transfers', async () => {
    const walletA = await client
      .post('/wallets')
      .send({ userId: 'user-a2', ownerName: 'Alice' })
      .expect(201);
    const walletB = await client
      .post('/wallets')
      .send({ userId: 'user-b2', ownerName: 'Bob' })
      .expect(201);
    await client.post(`/wallets/${walletA.body._id}/deposit`).send({ amount: 500 }).expect(201);

    const idempotencyKey = uuidv4();
    const payload = {
      fromWalletId: walletA.body._id,
      toWalletId: walletB.body._id,
      amount: 100,
      idempotencyKey,
    };

    // Send 10 identical requests concurrently
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => client.post('/wallets/transfer').send(payload)),
    );

    const transferModel = getModel(app, Transfer.name);
    const transfers = await transferModel.find({ idempotencyKey });

    // Only one transfer record should exist
    expect(transfers.length).toBe(1);

    const finalA = await getModel(app, Wallet.name).findById(walletA.body._id);
    expect(finalA?.balance).toBe(400); // Only debited once
  });
});
