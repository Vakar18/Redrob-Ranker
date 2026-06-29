import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { getQueueToken } from '@nestjs/bullmq';
import { AppModule } from './app.module';
import { setupBullBoard } from './bull-board.setup';
import basicAuth = require('express-basic-auth');

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(ConfigService);
  const port = config.get<number>('app.port', 3000);
  const nodeEnv = config.get<string>('app.nodeEnv', 'development');

  // ── Security ──
  app.use(helmet());
  app.use(compression());
  app.enableCors();

  // ── Global validation ──
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ── API prefix ──
  app.setGlobalPrefix('api/v1');

  // ── Swagger (dev only) ──
  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Redrob Candidate Ranker API')
      .setDescription('Intelligent Candidate Discovery & Ranking System')
      .setVersion('1.0')
      .addTag('ranking', 'Pipeline control endpoints')
      .addTag('candidates', 'Candidate data endpoints')
      .addTag('health', 'Health checks')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log(`Swagger UI: http://localhost:${port}/api/docs`);

    // ── Bull Board (dev only) ──
    try {
       // 1. Get credentials from configuration
      const bullUser = config.get<string>('bullboard.username', process.env.BULL_BOARD_USER ?? 'admin');
      const bullPass = config.get<string>('bullboard.password', process.env.BULL_BOARD_PASSWORD ?? 'admin');

      // 2. Apply Basic Auth middleware to the Bull Board route
      app.use(
        '/admin/bull-board',
        basicAuth({
          users: { [bullUser]: bullPass },
          challenge: true,          // sends a 401 if not authenticated
        }),
      );

      // 3. Mount Bull Board after the auth middleware
      const rankingQueue = app.get(getQueueToken('ranking'));
      setupBullBoard(app, [rankingQueue]);
      logger.log(`🎛️ Bull Board: http://localhost:${port}/admin/bull-board`);
    } catch (error) {
      logger.warn('Bull Board setup skipped - queue not available');
    }
  }

  await app.listen(port);
  logger.log(`🚀 Redrob Ranker running on port ${port} [${nodeEnv}]`);
  logger.log(`📊 Health check: http://localhost:${port}/api/v1/health`);
}

bootstrap();
