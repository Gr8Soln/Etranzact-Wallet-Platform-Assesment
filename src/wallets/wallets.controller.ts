import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LedgerEntryDirection } from '../ledger/schemas/ledger-entry.schema';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { WalletOwnerGuard } from './guards/wallet-owner.guard';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('wallets')
@UseGuards(WalletOwnerGuard)
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  create(@Body() dto: CreateWalletDto) {
    return this.walletsService.createWallet(dto);
  }

  @Throttle({ default: { limit: 15, ttl: 10000 } })
  @Post('transfer')
  transfer(@Body() dto: TransferDto) {
    return this.walletsService.transfer(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.walletsService.getWallet(id);
  }

  @Get(':id/dashboard')
  dashboard(@Param('id') id: string) {
    return this.walletsService.getDashboard(id);
  }

  @Post(':id/deposit')
  deposit(@Param('id') id: string, @Body() dto: DepositDto) {
    return this.walletsService.deposit(id, dto);
  }

  @Post(':id/withdraw')
  withdraw(@Param('id') id: string, @Body() dto: WithdrawDto) {
    return this.walletsService.withdraw(id, dto);
  }

  @Get(':id/reconcile')
  reconcile(@Param('id') id: string) {
    return this.walletsService.reconcile(id);
  }

  @Get(':id/audit')
  audit(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('direction') direction?: LedgerEntryDirection,
  ) {
    return this.walletsService.getAuditTrail(
      id,
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
      direction,
    );
  }
}
