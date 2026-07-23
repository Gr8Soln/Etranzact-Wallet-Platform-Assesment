import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transfer, TransferDocument, TransferStatus } from '../wallets/schemas/transfer.schema';

@Injectable()
export class PendingTransferWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingTransferWorker.name);
  private timer: NodeJS.Timeout;

  constructor(
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    const intervalMs = this.configService.getOrThrow<number>(
      'workers.pendingTransferSweepIntervalMs',
    );
    this.timer = setInterval(() => this.sweep(), intervalMs);
  }

  private async sweep() {
    const timeoutMs = this.configService.getOrThrow<number>('workers.pendingTransferTimeoutMs');
    const cutoff = new Date(Date.now() - timeoutMs);

    const stale = await this.transferModel
      .find({ status: TransferStatus.PENDING, createdAt: { $lt: cutoff } })
      .exec();

    for (const transfer of stale) {
      transfer.status = TransferStatus.FAILED;
      transfer.failureReason = `Transfer timed out after ${timeoutMs}ms in PENDING state`;
      await transfer.save();
      this.logger.warn(
        `Marked transfer ${transfer.id} as FAILED (pending since ${transfer.createdAt?.toISOString()})`,
      );
    }
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }
}
