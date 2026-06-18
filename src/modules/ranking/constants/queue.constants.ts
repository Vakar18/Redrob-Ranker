export const RANKING_QUEUE = 'ranking';

export const RANKING_JOB_TYPES = {
  SCORE_BATCH: 'score-batch',
  FINALIZE_RANKING: 'finalize-ranking',
} as const;

export const QUEUE_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 2000,
  },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};
