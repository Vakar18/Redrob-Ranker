import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { CandidatesService } from '../../candidates/services/candidates.service';
import {
  RANKING_QUEUE,
  RANKING_JOB_TYPES,
  QUEUE_DEFAULT_JOB_OPTIONS,
} from '../constants/queue.constants';
import { StartRankingDto } from '../dto/start-ranking.dto';

export interface RankingStatus {
  totalCandidates: number;
  scoredCandidates: number;
  progress: number;
  status: 'idle' | 'running' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
}

@Injectable()
export class RankingService {
  private readonly logger = new Logger(RankingService.name);
  private rankingStatus: RankingStatus = {
    totalCandidates: 0,
    scoredCandidates: 0,
    progress: 0,
    status: 'idle',
  };

  constructor(
    @InjectQueue(RANKING_QUEUE) private readonly rankingQueue: Queue,
    private readonly candidatesService: CandidatesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Kick off the full ranking pipeline:
   * 1. Chunk the candidate pool into batches
   * 2. Enqueue a SCORE_BATCH job per chunk (BullMQ processes concurrently)
   * 3. Enqueue a FINALIZE_RANKING job with a delay to run after all batches
   */
  async startRanking(dto: StartRankingDto): Promise<{ jobCount: number; message: string }> {
    const batchSize = dto.batchSize ?? this.config.get<number>('ranking.batchSize', 50);
    const topN = dto.topN ?? this.config.get<number>('ranking.topN', 100);
    const enableLlmRerank = dto.enableLlmRerank ?? true;
    const llmBatchSize = dto.llmBatchSize ?? 10;
    const outputPath = dto.outputPath ?? './submission.csv';

    const totalCandidates = await this.candidatesService.count();
    if (totalCandidates === 0) {
      throw new Error('No candidates in database. Run the ingestion script first.');
    }

    this.logger.log(
      `Starting ranking pipeline: ${totalCandidates} candidates, batch size ${batchSize}, LLM rerank: ${enableLlmRerank}`,
    );

    this.rankingStatus = {
      totalCandidates,
      scoredCandidates: 0,
      progress: 0,
      status: 'running',
      startedAt: new Date(),
    };

    // Fetch all candidate IDs (lean, just the IDs for queue partitioning)
    const allIds = await this.getAllCandidateIds();
    const batches = this.chunkArray(allIds, batchSize);

    // Enqueue batch scoring jobs
    const batchJobs = batches.map((ids, idx) => ({
      name: RANKING_JOB_TYPES.SCORE_BATCH,
      data: {
        batchIndex: idx,
        candidateIds: ids,
        enableLlmRerank,
        llmBatchSize,
      },
      opts: {
        ...QUEUE_DEFAULT_JOB_OPTIONS,
        jobId: `score-batch-${idx}`,
        priority: 10,
      },
    }));

    await this.rankingQueue.addBulk(batchJobs);

    // Enqueue finalization job with a delay large enough for all batches to complete
    // In production you'd use a flow/barrier pattern; this simple delay works for hackathon scale
    const estimatedBatchMs = batchSize * 50; // ~50ms per candidate
    const totalDelayMs = batches.length * estimatedBatchMs + 30_000; // +30s buffer

    await this.rankingQueue.add(
      RANKING_JOB_TYPES.FINALIZE_RANKING,
      { topN, outputPath },
      {
        ...QUEUE_DEFAULT_JOB_OPTIONS,
        jobId: 'finalize-ranking',
        delay: totalDelayMs,
        priority: 1, // Low priority — runs after all batch jobs
      },
    );

    this.logger.log(`Enqueued ${batchJobs.length} batch jobs + 1 finalization job`);

    return {
      jobCount: batchJobs.length + 1,
      message: `Ranking pipeline started. ${batchJobs.length} batch jobs enqueued. Estimated completion: ${Math.round(totalDelayMs / 60000)} minutes.`,
    };
  }

  async getStatus(): Promise<RankingStatus> {
    const scored = await this.candidatesService.countScored();
    const total = this.rankingStatus.totalCandidates || (await this.candidatesService.count());
    const progress = total > 0 ? Math.round((scored / total) * 100) : 0;

    return {
      ...this.rankingStatus,
      scoredCandidates: scored,
      progress,
    };
  }

  async getQueueMetrics(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.rankingQueue.getWaitingCount(),
      this.rankingQueue.getActiveCount(),
      this.rankingQueue.getCompletedCount(),
      this.rankingQueue.getFailedCount(),
      this.rankingQueue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  }

  async clearQueue(): Promise<void> {
    await this.rankingQueue.obliterate({ force: true });
    this.logger.warn('Queue obliterated');
  }

  async retryFailed(): Promise<number> {
    const failedJobs = await this.rankingQueue.getFailed();
    await Promise.all(failedJobs.map((j) => j.retry()));
    return failedJobs.length;
  }

  /**
   * Pause the worker to stop processing jobs
   */
  async pauseWorker(): Promise<void> {
    await this.rankingQueue.pause();
    this.logger.log('Ranking queue paused - no more jobs will be processed');
  }

  /**
   * Resume the worker to process jobs
   */
  async resumeWorker(): Promise<void> {
    await this.rankingQueue.resume();
    this.logger.log('Ranking queue resumed - jobs will be processed again');
  }

  /**
   * Get pause status
   */
  async isPaused(): Promise<boolean> {
    const isPaused = await this.rankingQueue.isPaused();
    return isPaused;
  }

  private async getAllCandidateIds(): Promise<string[]> {
    // Use aggregation for memory efficiency on large datasets
    const docs = await this.candidatesService['candidateModel']
      .find({}, { candidate_id: 1, _id: 0 }, { lean: true })
      .exec();
    return (docs as any[]).map((d) => d.candidate_id);
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
