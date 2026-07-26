import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter } from 'events';
import { Model } from 'mongoose';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';

export const walletEventBus = new EventEmitter();
walletEventBus.setMaxListeners(0);

/**
 * Watches wallets whose balance recently changed and logs a snapshot for
 * downstream monitoring dashboards. Ticks on a fixed interval.
 */
@Injectable()
export class WalletEventsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WalletEventsWorker.name);
  private timer: NodeJS.Timeout;

  constructor(@InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>) {}

  onModuleInit() {
    // Bind listener once to prevent memory leak
    walletEventBus.on('wallet.snapshot', (data: { walletId: string, balance: number }) => {
      this.logger.debug(`Wallet ${data.walletId} snapshot balance=${data.balance}`);
    });
    this.timer = setInterval(() => this.tick(), 10_000);
  }

  private async tick() {
    const recentWallets = await this.walletModel.find().sort({ updatedAt: -1 }).limit(20).exec();

    for (const wallet of recentWallets) {
      walletEventBus.emit('wallet.snapshot', { walletId: wallet.id, balance: wallet.balance });
    }
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }
}
