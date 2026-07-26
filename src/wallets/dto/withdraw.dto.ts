import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

export class WithdrawDto {
  @ApiProperty({ example: 50 })
  @IsNumber()
  @IsPositive()
  @Min(0.01)
  @Max(Number.MAX_SAFE_INTEGER)
  amount: number;

  @ApiPropertyOptional({ description: 'Client supplied idempotency key' })
  @IsOptional()
  @IsString()
  reference?: string;
}
