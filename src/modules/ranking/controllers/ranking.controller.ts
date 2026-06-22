import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RankingService } from '../services/ranking.service';
import { StartRankingDto } from '../dto/start-ranking.dto';

@ApiTags('ranking')
@Controller('ranking')
export class RankingController {
  private readonly logger = new Logger(RankingController.name);

  constructor(private readonly rankingService: RankingService) {}

  @Post('start')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start the ranking pipeline (enqueues BullMQ jobs)' })
  async startRanking(@Body() dto: StartRankingDto) {
    const result = await this.rankingService.startRanking(dto);
    return { success: true, ...result };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get current ranking pipeline status and progress' })
  async getStatus() {
    return this.rankingService.getStatus();
  }

  @Get('queue')
  @ApiOperation({ summary: 'Get BullMQ queue metrics' })
  async getQueueMetrics() {
    return this.rankingService.getQueueMetrics();
  }

  @Post('retry-failed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry all failed queue jobs' })
  async retryFailed() {
    const count = await this.rankingService.retryFailed();
    return { success: true, retriedJobs: count };
  }

  @Delete('queue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear the ranking queue (use with caution)' })
  async clearQueue() {
    await this.rankingService.clearQueue();
    return { success: true, message: 'Queue cleared' };
  }

  @Post('pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause the ranking worker (stops processing jobs)' })
  async pauseWorker() {
    await this.rankingService.pauseWorker();
    return { success: true, message: 'Ranking worker paused' };
  }

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume the ranking worker (resumes processing jobs)' })
  async resumeWorker() {
    await this.rankingService.resumeWorker();
    return { success: true, message: 'Ranking worker resumed' };
  }

  @Get('pause-status')
  @ApiOperation({ summary: 'Get the pause status of the ranking worker' })
  async getPauseStatus() {
    const isPaused = await this.rankingService.isPaused();
    return { isPaused };
  }
}
