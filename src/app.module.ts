import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  appConfig,
  mongoConfig,
  redisConfig,
  llmConfig,
  rankingConfig,
} from './config/app.config';
import { CandidatesModule } from './modules/candidates/candidates.module';
import { RankingModule } from './modules/ranking/ranking.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // ── Config ──
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, mongoConfig, redisConfig, llmConfig, rankingConfig],
      envFilePath: ['.env.local', '.env'],
    }),

    // ── MongoDB ──
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongo.uri'),
        dbName: config.get<string>('mongo.dbName'),
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
      }),
    }),

    // ── BullMQ (root Redis connection) ──
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host', 'localhost'),
          port: config.get<number>('redis.port', 6379),
          password: config.get<string>('redis.password') || undefined,
          db: config.get<number>('redis.db', 0),
          maxRetriesPerRequest: null, // Required for BullMQ
          enableReadyCheck: false,
        },
      }),
    }),

    // ── Rate limiting ──
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),

    // ── Feature modules ──
    CandidatesModule,
    RankingModule,
    HealthModule,
  ],
})
export class AppModule {}
