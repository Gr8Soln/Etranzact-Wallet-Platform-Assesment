import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { RedisService } from '../redis/redis.service';

/**
 * Watches wallets whose balance changes utilizing native MongoDB Change Streams
 * and propagates events globally via Redis Pub/Sub, eliminating CPU polling loops.
 */
@Injectable()
export class WalletEventsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WalletEventsWorker.name);
  private changeStream: any;
  private subscriberClient: any;

  constructor(
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    private readonly redisService: RedisService
  ) {}

  async onModuleInit() {
    // 1. Setup Redis Subscriber for cross-node global event propagation
    this.subscriberClient = this.redisService.getClient().duplicate();
    await this.subscriberClient.subscribe('wallet-snapshots');
    this.subscriberClient.on('message', (channel: string, message: string) => {
      if (channel === 'wallet-snapshots') {
        const data = JSON.parse(message);
        this.logger.debug(`[Global Event] Wallet ${data.walletId} snapshot balance=${data.balance}`);
      }
    });

    // 2. Setup MongoDB Native Change Stream to eliminate DB polling loops
    this.changeStream = this.walletModel.watch([
      { $match: { 'operationType': { $in: ['insert', 'update'] } } }
    ]);

    this.changeStream.on('change', async (change: any) => {
      if (change.operationType === 'update' && change.updateDescription.updatedFields.balance !== undefined) {
        const walletId = change.documentKey._id.toString();
        const balance = change.updateDescription.updatedFields.balance;
        
        // Publish strictly to Redis for distributed cluster consumption
        await this.redisService.getClient().publish('wallet-snapshots', JSON.stringify({ walletId, balance }));
      }
    });
  }

  async onModuleDestroy() {
    if (this.changeStream) {
      await this.changeStream.close();
    }
    if (this.subscriberClient) {
      await this.subscriberClient.quit();
    }
  }
}
