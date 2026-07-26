import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import { Connection } from 'mongoose';
import { Public } from '../common/decorators/public.decorator';
import { RabbitMQService } from '../queue/rabbitmq.service';
import { RedisService } from '../redis/redis.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly redisService: RedisService,
    private readonly rabbitMQService: RabbitMQService,
  ) {}

  @Public()
  @Get()
  async check() {
    const mongoState = this.connection.readyState === 1 ? 'up' : 'down';

    let redisState = 'down';
    try {
      await this.redisService.getClient().ping();
      redisState = 'up';
    } catch {
      redisState = 'down';
    }

    let rabbitmqState = 'down';
    try {
      const channel = this.rabbitMQService.getChannelWrapper();
      if (channel) {
        rabbitmqState = 'up';
      }
    } catch {
      rabbitmqState = 'down';
    }

    const isHealthy = mongoState === 'up' && redisState === 'up' && rabbitmqState === 'up';

    const healthStatus = {
      status: isHealthy ? 'ok' : 'degraded',
      mongo: mongoState,
      redis: redisState,
      rabbitmq: rabbitmqState,
      timestamp: new Date().toISOString(),
    };

    if (!isHealthy) {
      throw new ServiceUnavailableException(healthStatus);
    }

    return healthStatus;
  }
}
