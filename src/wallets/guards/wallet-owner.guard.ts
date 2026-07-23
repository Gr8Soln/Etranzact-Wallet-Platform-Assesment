import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Wallet, WalletDocument } from '../schemas/wallet.schema';

@Injectable()
export class WalletOwnerGuard implements CanActivate {
  constructor(
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const walletId = request.params?.id;

    // Routes without a wallet id parameter (:id param) (like POST /wallets)
    // are not subject to ownership checks here.
    if (!walletId) {
      return true;
    }

    const wallet = await this.walletModel.findById(walletId);
    if (!wallet) {
      // This let the service layer throw NotFoundException with the proper message.
      return true;
    }

    if (wallet.userId !== request.user?.userId) {
      throw new ForbiddenException('You do not have access to this wallet');
    }

    return true;
  }
}
