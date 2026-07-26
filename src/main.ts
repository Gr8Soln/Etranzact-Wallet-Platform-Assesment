import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const jwtSecret = process.env.JWT_SECRET || 'change-me-in-production';
  if (process.env.NODE_ENV === 'production') {
    if (!jwtSecret || jwtSecret === 'change-me-in-production' || jwtSecret.length < 32) {
      Logger.error('FATAL: A secure JWT_SECRET (at least 32 characters) must be configured in production mode.', 'Bootstrap');
      process.exit(1);
    }
  }

  const app = await NestFactory.create(AppModule);

  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Wallet Platform API')
    .setDescription('Wallets, deposits, withdrawals, transfers and ledger')
    .setVersion('1.4.2')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(`Wallet Platform API listening on port ${port}`, 'Bootstrap');
}

bootstrap();
