import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Candidate, CandidateSchema } from './schemas/candidate.schema';
import { CandidatesService } from './services/candidates.service';
import { CandidatesController } from './controllers/candidates.controller';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import { BullAdapter } from '@bull-board/api/bullAdapter';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Candidate.name, schema: CandidateSchema }]),
  ],
  providers: [CandidatesService],
  controllers: [CandidatesController],
  exports: [CandidatesService, MongooseModule],
})
export class CandidatesModule {}
