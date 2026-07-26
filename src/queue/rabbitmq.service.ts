import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqp-connection-manager';
import { ChannelWrapper } from 'amqp-connection-manager';
import { ConfirmChannel } from 'amqplib';

import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: amqp.AmqpConnectionManager;
  private channelWrapper: ChannelWrapper;
  private readonly exchange: string;
  private readonly transferQueue: string;

  constructor(private readonly configService: ConfigService) {
    this.exchange = this.configService.getOrThrow<string>('rabbitmq.exchange');
    this.transferQueue = this.configService.getOrThrow<string>('rabbitmq.transferQueue');
  }

  async onModuleInit() {
    const uri = this.configService.getOrThrow<string>('rabbitmq.uri');
    this.connection = amqp.connect([uri]);
    this.connection.on('connectFailed', (err) =>
      this.logger.error(`RabbitMQ connection failed: ${err?.err?.message}`),
    );

    const dlxName = `${this.exchange}.dlx`;
    const dlqName = `${this.transferQueue}.dlq`;

    this.channelWrapper = this.connection.createChannel({
      json: true,
      setup: (channel: ConfirmChannel) =>
        Promise.all([
          channel.prefetch(10),
          channel.assertExchange(this.exchange, 'topic', { durable: true }),
          channel.assertExchange(dlxName, 'topic', { durable: true }),
          channel.assertQueue(this.transferQueue, {
            durable: true,
            arguments: { 'x-dead-letter-exchange': dlxName },
          }),
          channel.bindQueue(this.transferQueue, this.exchange, 'transfer.*'),
          channel.assertQueue(dlqName, { durable: true }),
          channel.bindQueue(dlqName, dlxName, '#'),
        ]),
    });
  }

  async publish(routingKey: string, payload: Record<string, unknown>): Promise<void> {
    const messageId = (payload.messageId as string) || uuidv4();
    await this.channelWrapper.publish(this.exchange, routingKey, { ...payload, messageId }, {
      persistent: true,
      messageId,
    });
    this.logger.log(`Published event ${routingKey} (messageId: ${messageId})`);
  }

  getChannelWrapper(): ChannelWrapper {
    return this.channelWrapper;
  }

  getTransferQueue(): string {
    return this.transferQueue;
  }

  async onModuleDestroy() {
    await this.channelWrapper?.close();
    await this.connection?.close();
  }
}
