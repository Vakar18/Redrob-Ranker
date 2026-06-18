import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';

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
  }

  await app.listen(port);
  logger.log(`🚀 Redrob Ranker running on port ${port} [${nodeEnv}]`);
  logger.log(`📊 Health check: http://localhost:${port}/api/v1/health`);
}

bootstrap();
