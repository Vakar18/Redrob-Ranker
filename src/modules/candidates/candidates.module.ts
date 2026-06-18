import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Candidate, CandidateSchema } from './schemas/candidate.schema';
import { CandidatesService } from './services/candidates.service';
import { CandidatesController } from './controllers/candidates.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Candidate.name, schema: CandidateSchema }]),
  ],
  providers: [CandidatesService],
  controllers: [CandidatesController],
  exports: [CandidatesService, MongooseModule],
})
export class CandidatesModule {}
