import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CandidatesService } from '../../candidates/services/candidates.service';
import { DeterministicScorer } from '../strategies/deterministic-scorer';
import { LlmReranker } from '../strategies/llm-reranker';
import { RawCandidate } from '../../../types/candidate.types';
import { RANKING_QUEUE, RANKING_JOB_TYPES } from '../constants/queue.constants';

export interface ScoreBatchJobData {
  batchIndex: number;
  candidateIds: string[];
  enableLlmRerank: boolean;
  llmBatchSize: number;
}

export interface FinalizeRankingJobData {
  topN: number;
  outputPath: string;
}

@Processor(RANKING_QUEUE)
export class RankingProcessor extends WorkerHost {
  private readonly logger = new Logger(RankingProcessor.name);

  constructor(
    private readonly candidatesService: CandidatesService,
    private readonly deterministicScorer: DeterministicScorer,
    private readonly llmReranker: LlmReranker,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name} (attempt ${job.attemptsMade + 1})`);

    switch (job.name) {
      case RANKING_JOB_TYPES.SCORE_BATCH:
        return this.handleScoreBatch(job as Job<ScoreBatchJobData>);
      case RANKING_JOB_TYPES.FINALIZE_RANKING:
        return this.handleFinalizeRanking(job as Job<FinalizeRankingJobData>);
      default:
        throw new Error(`Unknown job type: ${job.name}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Job: SCORE_BATCH
  // Deterministically score a batch of candidates, optionally
  // followed by LLM re-ranking for the top performers.
  // ─────────────────────────────────────────────────────────────

  private async handleScoreBatch(job: Job<ScoreBatchJobData>): Promise<{ processed: number; errors: number }> {
    const { batchIndex, candidateIds, enableLlmRerank, llmBatchSize } = job.data;
    this.logger.log(`Batch ${batchIndex}: scoring ${candidateIds.length} candidates`);

    // Fetch candidates from MongoDB
    const candidates: RawCandidate[] = await Promise.all(
      candidateIds.map(async (id) => {
        try {
          const doc = await this.candidatesService.findById(id);
          return doc as unknown as RawCandidate;
        } catch {
          return null;
        }
      }),
    ).then((docs) => docs.filter(Boolean) as RawCandidate[]);

    // ── Step 1: Deterministic scoring ──
    const deterministicResults = candidates.map((candidate) => {
      const result = this.deterministicScorer.score(candidate);
      return { candidate, ...result };
    });

    // ── Step 2: LLM re-ranking for top scorers ──
    let llmResults: Map<string, { llmScore: number; reasoning: string }> = new Map();

    if (enableLlmRerank) {
      // Only send promising candidates to LLM (saves API costs)
      const topCandidates = deterministicResults
        .filter((r) => !r.isHoneypot && r.breakdown.total >= 40)
        .sort((a, b) => b.breakdown.total - a.breakdown.total)
        .slice(0, llmBatchSize);

      if (topCandidates.length > 0) {
        try {
          const llmRankings = await this.llmReranker.rerank(
            topCandidates.map((r) => ({
              candidate: r.candidate,
              deterministicScore: r.breakdown,
            })),
          );
          for (const lr of llmRankings) {
            llmResults.set(lr.candidate_id, lr);
          }
        } catch (err) {
          this.logger.warn(`LLM reranking failed for batch ${batchIndex}: ${err.message}`);
        }
      }
    }

    // ── Step 3: Compute final blended scores ──
    const scoreUpdates = await Promise.all(
      deterministicResults.map(async ({ candidate, breakdown, isHoneypot, disqualificationReason }) => {
        let finalScore = breakdown.total;
        let reasoning = '';

        if (!isHoneypot && disqualificationReason === null) {
          const llmResult = llmResults.get(candidate.candidate_id);
          if (llmResult) {
            // Blend: 60% deterministic, 40% LLM semantic score
            finalScore = breakdown.total * 0.6 + llmResult.llmScore * 0.4;
            reasoning = llmResult.reasoning;
          } else {
            // No LLM result — generate reasoning from deterministic data
            reasoning = this.buildDeterministicReasoning(candidate, breakdown);
          }
        }

        return {
          candidate_id: candidate.candidate_id,
          computed_skill_score: breakdown.skillMatch,
          computed_career_score: breakdown.careerFit,
          computed_behavioral_score: breakdown.behavioral,
          computed_availability_score: breakdown.availability,
          computed_total_score: Math.round(finalScore * 100) / 100,
          is_honeypot: isHoneypot,
          disqualification_reason: disqualificationReason,
          reasoning,
        };
      }),
    );

    // ── Step 4: Persist to MongoDB ──
    await this.candidatesService.bulkUpdateScores(scoreUpdates);

    await job.updateProgress(100);
    this.logger.log(`Batch ${batchIndex}: completed — ${scoreUpdates.length} candidates scored`);

    return {
      processed: scoreUpdates.filter((u) => !u.is_honeypot).length,
      errors: candidates.length - scoreUpdates.length,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Job: FINALIZE_RANKING
  // Pull top-N from MongoDB and write the submission CSV.
  // ─────────────────────────────────────────────────────────────

  private async handleFinalizeRanking(job: Job<FinalizeRankingJobData>): Promise<{ outputPath: string }> {
    const { topN, outputPath } = job.data;
    this.logger.log(`Finalizing ranking: top ${topN} candidates → ${outputPath}`);

    const topCandidates = await this.candidatesService.getTopN(topN);
    this.logger.log(`Retrieved ${topCandidates.length} top candidates from MongoDB`);

    // Generate CSV content
    const csvRows = ['candidate_id,rank,score,reasoning'];

    // Sort by score descending, apply tie-breaking by candidate_id ascending
    const sorted = [...topCandidates].sort((a, b) => {
      const scoreDiff = (b.computed_total_score ?? 0) - (a.computed_total_score ?? 0);
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
      return a.candidate_id.localeCompare(b.candidate_id);
    });

    for (let i = 0; i < Math.min(sorted.length, topN); i++) {
      const c = sorted[i] as any;
      const rank = i + 1;
      const score = (c.computed_total_score ?? 0).toFixed(4);
      // Sanitize reasoning for CSV (remove commas, newlines, double quotes)
      const reasoning = (c.reasoning || `Ranked ${rank}: composite score ${score}/100 across skills, career, and behavioral signals.`)
        .replace(/"/g, "'")
        .replace(/[\r\n,]/g, ' ')
        .slice(0, 200);

      csvRows.push(`${c.candidate_id},${rank},${score},"${reasoning}"`);
    }

    const { writeFileSync } = await import('fs');
    writeFileSync(outputPath, csvRows.join('\n') + '\n', 'utf-8');

    this.logger.log(`Submission CSV written to: ${outputPath}`);
    return { outputPath };
  }

  private buildDeterministicReasoning(candidate: RawCandidate, breakdown: any): string {
    const top3Skills = candidate.skills.slice(0, 3).map((s) => s.name).join(', ');
    const yoe = candidate.profile.years_of_experience;
    const company = candidate.profile.current_company;
    return `${yoe}y AI/ML engineer at ${company} with ${top3Skills}; skill match ${breakdown.skillMatch.toFixed(0)}/100, career fit ${breakdown.careerFit.toFixed(0)}/100.`;
  }
}
