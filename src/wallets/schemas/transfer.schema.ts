import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type TransferDocument = HydratedDocument<Transfer>;

export enum TransferStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Schema({ timestamps: true, collection: 'transfers' })
export class Transfer {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Wallet', required: true })
  fromWalletId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Wallet', required: true })
  toWalletId: Types.ObjectId;

  @Prop({ required: true })
  amount: number;

  @Prop({ type: String, enum: TransferStatus, default: TransferStatus.PENDING })
  status: TransferStatus;

  @Prop()
  idempotencyKey?: string;

  @Prop()
  failureReason?: string;

  @Prop()
  lastSweptAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const TransferSchema = SchemaFactory.createForClass(Transfer);

// Missing Query Route Index: Ensures ultra-fast consumer idempotency locks
TransferSchema.index({ _id: 1, status: 1 });

// Updated Sort Path: Aligned with descending analytics and sweep queries
TransferSchema.index({ status: 1, createdAt: -1 });
TransferSchema.index({ status: 1, lastSweptAt: 1 });

// Enforce unique idempotency keys to prevent concurrent duplicate transfers
TransferSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
