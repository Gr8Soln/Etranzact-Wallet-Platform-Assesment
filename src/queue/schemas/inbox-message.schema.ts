import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type InboxMessageDocument = HydratedDocument<InboxMessage>;

@Schema({ timestamps: true, collection: 'inbox_messages' })
export class InboxMessage {
  @Prop({ required: true, unique: true, index: true })
  messageId: string;

  @Prop({ default: Date.now, expires: 86400 * 7 }) // Automatically clean up inbox entries after 7 days
  createdAt?: Date;
}

export const InboxMessageSchema = SchemaFactory.createForClass(InboxMessage);
