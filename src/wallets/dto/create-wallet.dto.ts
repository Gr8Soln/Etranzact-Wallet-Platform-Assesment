import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO4217, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateWalletDto {
  @ApiProperty({ example: 'user-1001' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: 'Ama Owusu' })
  @IsString()
  @IsNotEmpty()
  ownerName: string;

  @ApiPropertyOptional({ example: 'GHS', default: 'GHS' })
  @IsOptional()
  @IsString()
  @IsISO4217()
  currency?: string;
}
