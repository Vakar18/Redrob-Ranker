import {
  Controller,
  Get,
  Param,
  Query,
  Logger,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CandidatesService } from '../services/candidates.service';

@ApiTags('candidates')
@Controller('candidates')
export class CandidatesController {
  private readonly logger = new Logger(CandidatesController.name);

  constructor(private readonly candidatesService: CandidatesService) {}

  @Get('count')
  @ApiOperation({ summary: 'Get total candidate count' })
  async count() {
    const total = await this.candidatesService.count();
    const scored = await this.candidatesService.countScored();
    return { total, scored, pending: total - scored };
  }

  @Get('top')
  @ApiOperation({ summary: 'Get top-N ranked candidates' })
  @ApiQuery({ name: 'n', required: false, type: Number, description: 'How many to return (default 100)' })
  async getTop(
    @Query('n', new DefaultValuePipe(100), ParseIntPipe) n: number,
  ) {
    const candidates = await this.candidatesService.getTopN(Math.min(n, 100));
    return {
      count: candidates.length,
      candidates: candidates.map((c) => ({
        candidate_id: (c as any).candidate_id,
        score: (c as any).computed_total_score,
        skill_score: (c as any).computed_skill_score,
        career_score: (c as any).computed_career_score,
        behavioral_score: (c as any).computed_behavioral_score,
        availability_score: (c as any).computed_availability_score,
        title: (c as any).profile?.current_title,
        company: (c as any).profile?.current_company,
        yoe: (c as any).profile?.years_of_experience,
        location: (c as any).profile?.location,
      })),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get candidate by ID' })
  async findOne(@Param('id') id: string) {
    return this.candidatesService.findById(id);
  }
}
