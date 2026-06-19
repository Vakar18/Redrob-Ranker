import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT ?? '3000', 10) || 3000,
  name: process.env.APP_NAME || 'redrob-ranker',
}));

export const mongoConfig = registerAs('mongo', () => ({
  uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/redrob_ranker',
  dbName: process.env.MONGODB_DB_NAME || 'redrob_ranker',
}));

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB ?? '0', 10) || 0,
}));

export const llmConfig = registerAs('llm', () => ({
  // Which provider to try first
  provider: process.env.LLM_PROVIDER || 'groq',
  // Fallback if primary fails or rate-limits
  fallbackProvider: process.env.LLM_FALLBACK_PROVIDER || 'gemini',

  // Groq — free, fast. Model name is AUTO-DISCOVERED at runtime since
  // Groq's free-tier catalog changes often (old names get decommissioned).
  // Set GROQ_MODEL only if you want to force a specific model.
  // Sign up: https://console.groq.com
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || '', // empty = auto-discover
    maxTokens: 2048,
  },

  // Google Gemini — free tier. Model name is AUTO-DISCOVERED at runtime
  // for the same reason. Set GEMINI_MODEL to force a specific model.
  // Get key: https://aistudio.google.com/app/apikey
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || '', // empty = auto-discover
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
  batchSize: parseInt(process.env.RANKING_BATCH_SIZE ?? '50', 10) || 50,
  concurrency: parseInt(process.env.RANKING_CONCURRENCY ?? '5', 10) || 5,
  topN: parseInt(process.env.RANKING_TOP_N ?? '100', 10) || 100,
  jobTimeoutMs: parseInt(process.env.RANKING_JOB_TIMEOUT_MS ?? '600000', 10) || 600000,
  weights: {
    skillMatch: parseFloat(process.env.WEIGHT_SKILL_MATCH ?? '0.35') || 0.35,
    careerFit: parseFloat(process.env.WEIGHT_CAREER_FIT ?? '0.30') || 0.30,
    behavioral: parseFloat(process.env.WEIGHT_BEHAVIORAL ?? '0.20') || 0.20,
    availability: parseFloat(process.env.WEIGHT_AVAILABILITY ?? '0.15') || 0.15,
  },
}));