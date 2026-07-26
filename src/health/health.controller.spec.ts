import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { getConnectionToken } from '@nestjs/mongoose';
import { RedisService } from '../redis/redis.service';
import { RabbitMQService } from '../queue/rabbitmq.service';

describe('HealthController', () => {
  let controller: HealthController;
  let mockConnection: any;
  let mockRedisService: any;
  let mockRabbitMQService: any;

  beforeEach(async () => {
    mockConnection = { readyState: 1 };
    mockRedisService = {
      getClient: jest.fn().mockReturnValue({ ping: jest.fn().mockResolvedValue('PONG') }),
    };
    mockRabbitMQService = {
      getChannelWrapper: jest.fn().mockReturnValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: getConnectionToken(), useValue: mockConnection },
        { provide: RedisService, useValue: mockRedisService },
        { provide: RabbitMQService, useValue: mockRabbitMQService },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  it('returns ok status when all dependencies are healthy', async () => {
    const result = await controller.check();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'ok',
        mongo: 'up',
        redis: 'up',
        rabbitmq: 'up',
      }),
    );
  });

  it('throws ServiceUnavailableException (503) when MongoDB is down', async () => {
    mockConnection.readyState = 0;
    await expect(controller.check()).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws ServiceUnavailableException (503) when Redis is down', async () => {
    mockRedisService.getClient.mockReturnValue({
      ping: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
    });
    await expect(controller.check()).rejects.toThrow(ServiceUnavailableException);
  });
});
