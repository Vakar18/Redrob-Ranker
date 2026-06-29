import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CandidatesModule } from '../candidates/candidates.module';
import { RankingProcessor } from './processors/ranking.processor';
import { RankingService } from './services/ranking.service';
import { RankingController } from './controllers/ranking.controller';
import { DeterministicScorer } from './strategies/deterministic-scorer';
import { LlmReranker } from './strategies/llm-reranker';
import { RANKING_QUEUE } from './constants/queue.constants';
import {  BullBoardModule } from '@bull-board/nestjs';
import { BullAdapter } from '@bull-board/api/bullAdapter';


@Module({
  imports: [
    CandidatesModule,
    BullModule.registerQueueAsync({
      name: RANKING_QUEUE,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host', 'localhost'),
          port: config.get<number>('redis.port', 6379),
          password: config.get<string>('redis.password') || undefined,
          db: config.get<number>('redis.db', 0),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        },
      }),
    }),
    // BullBoardModule.forFeature({
    //   name: RANKING_QUEUE,
    //   adapter: BullAdapter,
    // }),
  ],
  providers: [
    RankingProcessor,
    RankingService,
    DeterministicScorer,
    LlmReranker,
  ],
  controllers: [RankingController],
  exports: [RankingService],
})
export class RankingModule {}
