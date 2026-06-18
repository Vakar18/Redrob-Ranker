import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000,
  name: process.env.APP_NAME || 'redrob-ranker',
}));

export const mongoConfig = registerAs('mongo', () => ({
  uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/redrob_ranker',
  dbName: process.env.MONGODB_DB_NAME || 'redrob_ranker',
}));

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: process.env.REDIS_DB || 0,
}));

export const llmConfig = registerAs('llm', () => ({
  // Which provider to try first
  provider: process.env.LLM_PROVIDER || 'groq',
  // Fallback if primary fails or rate-limits
  fallbackProvider: process.env.LLM_FALLBACK_PROVIDER || 'gemini',

  // Groq — free, fast (llama3-70b, mixtral)
  // Sign up: https://console.groq.com
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'llama3-70b-8192',
    maxTokens: 2048,
  },

  // Google Gemini — free tier (1500 req/day, 60 req/min)
  // Get key: https://aistudio.google.com/app/apikey
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    maxTokens: 2048,
  },

  // Ollama — fully local, zero cost, no internet needed
  // Install: https://ollama.com  then: ollama pull llama3.1
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.1',
    maxTokens: 2048,
  },
}));

export const rankingConfig = registerAs('ranking', () => ({
  batchSize: (process.env.RANKING_BATCH_SIZE, 10) || 50,
  concurrency: (process.env.RANKING_CONCURRENCY, 10) || 5,
  topN: (process.env.RANKING_TOP_N, 10) || 100,
  jobTimeoutMs:   (process.env.RANKING_JOB_TIMEOUT_MS, 10) || 600000,
  weights: {
    skillMatch: (process.env.WEIGHT_SKILL_MATCH) || 0.35,
    careerFit: (process.env.WEIGHT_CAREER_FIT) || 0.30,
    behavioral: (process.env.WEIGHT_BEHAVIORAL) || 0.20,
    availability: (process.env.WEIGHT_AVAILABILITY) || 0.15,
  },
}));
