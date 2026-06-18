import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Candidate, CandidateDocument } from '../schemas/candidate.schema';
import { RawCandidate } from '../../../types/candidate.types';

@Injectable()
export class CandidatesService {
  private readonly logger = new Logger(CandidatesService.name);

  constructor(
    @InjectModel(Candidate.name)
    private readonly candidateModel: Model<CandidateDocument>,
  ) {}

  /**
   * Bulk upsert candidates from a JSONL source.
   * Uses ordered:false for maximum throughput on large datasets.
   */
  async bulkUpsert(candidates: RawCandidate[]): Promise<{ inserted: number; updated: number }> {
    const ops = candidates.map((c) => ({
      updateOne: {
        filter: { candidate_id: c.candidate_id },
        update: { $set: c },
        upsert: true,
      },
    }));

    const result = await this.candidateModel.bulkWrite(ops, { ordered: false });
    return {
      inserted: result.upsertedCount,
      updated: result.modifiedCount,
    };
  }

  /**
   * Fetch a paginated batch of candidates for scoring.
   * Uses lean() for performance — returns plain JS objects.
   */
  async findBatch(skip: number, limit: number): Promise<RawCandidate[]> {
    return this.candidateModel
      .find({}, null, { lean: true })
      .skip(skip)
      .limit(limit)
      .exec() as unknown as RawCandidate[];
  }

  async findById(candidateId: string): Promise<CandidateDocument> {
    const doc = await this.candidateModel.findOne({ candidate_id: candidateId });
    if (!doc) throw new NotFoundException(`Candidate ${candidateId} not found`);
    return doc;
  }

  async count(): Promise<number> {
    return this.candidateModel.countDocuments();
  }

  /**
   * Get total count of already-scored candidates.
   */
  async countScored(): Promise<number> {
    return this.candidateModel.countDocuments({ computed_total_score: { $ne: null } });
  }

  /**
   * Persist scoring results back to MongoDB in bulk.
   */
  async bulkUpdateScores(
    updates: Array<{
      candidate_id: string;
      computed_skill_score: number;
      computed_career_score: number;
      computed_behavioral_score: number;
      computed_availability_score: number;
      computed_total_score: number;
      is_honeypot: boolean;
      disqualification_reason: string | null;
    }>,
  ): Promise<void> {
    const ops = updates.map((u) => ({
      updateOne: {
        filter: { candidate_id: u.candidate_id },
        update: {
          $set: {
            computed_skill_score: u.computed_skill_score,
            computed_career_score: u.computed_career_score,
            computed_behavioral_score: u.computed_behavioral_score,
            computed_availability_score: u.computed_availability_score,
            computed_total_score: u.computed_total_score,
            is_honeypot: u.is_honeypot,
            disqualification_reason: u.disqualification_reason,
          },
        },
      },
    }));

    await this.candidateModel.bulkWrite(ops, { ordered: false });
    this.logger.debug(`Persisted scores for ${updates.length} candidates`);
  }

  /**
   * Retrieve top-N candidates by composite score, excluding honeypots.
   */
  async getTopN(n: number): Promise<CandidateDocument[]> {
    return this.candidateModel
      .find({ is_honeypot: false, computed_total_score: { $ne: null } })
      .sort({ computed_total_score: -1 })
      .limit(n)
      .exec();
  }

  /**
   * Stream all candidate IDs in batches (for large-scale processing).
   */
  async *streamInBatches(batchSize: number): AsyncGenerator<RawCandidate[]> {
    let skip = 0;
    while (true) {
      const batch = await this.findBatch(skip, batchSize);
      if (batch.length === 0) break;
      yield batch;
      skip += batchSize;
      if (batch.length < batchSize) break;
    }
  }
}
