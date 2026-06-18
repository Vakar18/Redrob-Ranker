import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class StartRankingDto {
  @ApiPropertyOptional({ description: 'Candidates per batch job', default: 50 })
  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(500)
  batchSize?: number;

  @ApiPropertyOptional({ description: 'Number of top candidates for final submission', default: 100 })
  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(100)
  topN?: number;

  @ApiPropertyOptional({ description: 'Enable Claude LLM re-ranking for semantic scoring', default: true })
  @IsOptional()
  @IsBoolean()
  enableLlmRerank?: boolean;

  @ApiPropertyOptional({ description: 'How many candidates per LLM call', default: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  llmBatchSize?: number;

  @ApiPropertyOptional({ description: 'Output CSV path', default: './submission.csv' })
  @IsOptional()
  @IsString()
  outputPath?: string;
}
