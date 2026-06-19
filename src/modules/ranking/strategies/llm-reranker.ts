import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { RawCandidate, ScoreBreakdown } from '../../../types/candidate.types';

// ── JD context (shared across all providers) ────────────────────
const JD_CONTEXT = `Senior AI Engineer — Redrob AI (Series A, Pune/Noida, Hybrid).
REQUIRES: production embeddings retrieval, vector DBs (Pinecone/FAISS/Qdrant), Python, eval frameworks (NDCG/MRR/MAP).
TARGET: 5-9 years, mostly at product companies (not consulting firms like TCS/Infosys/Wipro).
LOCATION: Pune/Noida preferred; Hyderabad, Mumbai, Delhi NCR fine; must be India-based or willing to relocate.
DISQUALIFIERS: entire career at consulting firms, CV/Speech as primary domain, under 4 years exp, no production evidence.
KEY: Career history evidence > keyword lists. An inactive candidate (>90d, low response rate) is not actually available.`;

export type LlmProvider = 'groq' | 'gemini' | 'ollama' | 'none';

export interface LlmEvaluation {
  candidate_id: string;
  llmScore: number;
  reasoning: string;
}

// ── Model candidate lists ─────────────────────────────────────────
// Provider catalogs change frequently (sometimes monthly) — these are
// tried in order at startup, and again mid-run if a model is rejected.

const GROQ_MODEL_CANDIDATES = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-4-scout',
  'qwen3-32b',
];

const GEMINI_MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
];

function isModelErrorMessage(msg: string | undefined): boolean {
  return /decommissioned|deprecated|not found|not supported|invalid.?model/i.test(msg || '');
}

// ────────────────────────────────────────────────────────────────
// Provider implementations
// ────────────────────────────────────────────────────────────────

async function callGroq(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const client = new Groq({ apiKey });
  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  return response.choices[0]?.message?.content ?? '';
}

async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
  });
  const result = await geminiModel.generateContent(userPrompt);
  return result.response.text();
}

async function callOllama(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_predict: maxTokens, temperature: 0.1 },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const data = (await response.json()) as any;
  return data?.message?.content ?? '';
}

// ── Live model discovery ──────────────────────────────────────────

async function discoverGroqModel(apiKey: string, override: string | null): Promise<string> {
  if (override) return override;
  if (!apiKey) return GROQ_MODEL_CANDIDATES[0];

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    const liveIds = new Set((data.data || []).map((m: any) => m.id));

    for (const candidate of GROQ_MODEL_CANDIDATES) {
      if (liveIds.has(candidate)) return candidate;
    }
    const anyModel = (data.data || []).find((m: any) => !/whisper|tts|guard/i.test(m.id));
    if (anyModel) return anyModel.id;
  } catch {
    // Fall through to default candidate below
  }
  return GROQ_MODEL_CANDIDATES[0];
}

async function discoverGeminiModel(apiKey: string, override: string | null): Promise<string> {
  if (override) return override;
  if (!apiKey) return GEMINI_MODEL_CANDIDATES[0];

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    const liveIds = new Set(
      (data.models || []).map((m: any) => m.name.replace('models/', '')),
    );

    for (const candidate of GEMINI_MODEL_CANDIDATES) {
      if (liveIds.has(candidate)) return candidate;
    }
    const anyFlash = [...liveIds].find(
      (id) => /flash/i.test(id as string) && !/image|tts|embed/i.test(id as string),
    );
    if (anyFlash) return anyFlash as string;
  } catch {
    // Fall through to default candidate below
  }
  return GEMINI_MODEL_CANDIDATES[0];
}

// ────────────────────────────────────────────────────────────────
// Main injectable service
// ────────────────────────────────────────────────────────────────

@Injectable()
export class LlmReranker implements OnModuleInit {
  private readonly logger = new Logger(LlmReranker.name);

  private readonly provider: LlmProvider;
  private readonly fallbackProvider: LlmProvider;
  private readonly groqKey: string;
  private readonly geminiKey: string;
  private readonly ollamaUrl: string;
  private readonly ollamaModel: string;
  private readonly maxTokens: number;

  // Explicit overrides from config (null = auto-discover)
  private readonly groqModelOverride: string | null;
  private readonly geminiModelOverride: string | null;

  // Resolved at module init via live discovery, then mutated in-place
  // by the self-healing retry logic if a model gets rejected mid-run.
  private groqModel: string;
  private geminiModel: string;
  private groqCandidateIdx = -1;
  private geminiCandidateIdx = -1;

  constructor(private readonly config: ConfigService) {
    this.provider = config.get<string>('llm.provider', 'groq') as LlmProvider;
    this.fallbackProvider = config.get<string>('llm.fallbackProvider', 'gemini') as LlmProvider;
    this.groqKey = config.get<string>('llm.groq.apiKey', '');
    this.geminiKey = config.get<string>('llm.gemini.apiKey', '');
    this.ollamaUrl = config.get<string>('llm.ollama.baseUrl', 'http://localhost:11434');
    this.ollamaModel = config.get<string>('llm.ollama.model', 'llama3.1');
    this.maxTokens = config.get<number>('llm.groq.maxTokens', 2048);

    // Only treat as an override if explicitly set (not the old hardcoded defaults)
    const groqCfg = config.get<string>('llm.groq.model', '');
    const geminiCfg = config.get<string>('llm.gemini.model', '');
    this.groqModelOverride = groqCfg && groqCfg.trim() ? groqCfg : null;
    this.geminiModelOverride = geminiCfg && geminiCfg.trim() ? geminiCfg : null;

    // Safe placeholders until onModuleInit resolves the real ones
    this.groqModel = this.groqModelOverride ?? GROQ_MODEL_CANDIDATES[0];
    this.geminiModel = this.geminiModelOverride ?? GEMINI_MODEL_CANDIDATES[0];

    this.logger.log(`LLM provider: ${this.provider} → fallback: ${this.fallbackProvider}`);
  }

  /**
   * Resolve which models are actually live on each provider right now.
   * Runs once at app startup so the first real request doesn't eat the
   * discovery latency.
   */
  async onModuleInit(): Promise<void> {
    const needsGroq = this.provider === 'groq' || this.fallbackProvider === 'groq';
    const needsGemini = this.provider === 'gemini' || this.fallbackProvider === 'gemini';

    if (needsGroq && this.groqKey) {
      this.groqModel = await discoverGroqModel(this.groqKey, this.groqModelOverride);
      this.logger.log(`Groq model resolved: ${this.groqModel}`);
    }
    if (needsGemini && this.geminiKey) {
      this.geminiModel = await discoverGeminiModel(this.geminiKey, this.geminiModelOverride);
      this.logger.log(`Gemini model resolved: ${this.geminiModel}`);
    }
  }

  /**
   * Re-rank a batch of candidates with the configured free LLM.
   */
  async rerank(
    candidates: Array<{ candidate: RawCandidate; deterministicScore: ScoreBreakdown }>,
  ): Promise<LlmEvaluation[]> {
    if (candidates.length === 0) return [];

    const systemPrompt = this.systemPrompt();
    const userPrompt = this.buildBatchPrompt(candidates);

    const raw = await this.callWithFallback(systemPrompt, userPrompt);
    return this.parseEvaluations(raw, candidates.map((c) => c.candidate));
  }

  /**
   * Generate a 1-2 sentence reasoning for one candidate.
   */
  async generateReasoning(candidate: RawCandidate, score: ScoreBreakdown): Promise<string> {
    const systemPrompt =
      'You are a technical recruiter writing concise candidate assessment notes. Write exactly 1-2 sentences (max 50 words). Be specific about real experience. No bullet points, no markdown.';
    const userPrompt =
      `JD: ${JD_CONTEXT}\n\nCandidate: ${this.candidateSummary(candidate)}\n` +
      `Scores: skill=${score.skillMatch.toFixed(0)}, career=${score.careerFit.toFixed(0)}, behavioral=${score.behavioral.toFixed(0)}, availability=${score.availability.toFixed(0)}\n\n` +
      `Write 1-2 sentence reasoning (plain text only):`;

    try {
      const raw = await this.callWithFallback(systemPrompt, userPrompt);
      return raw.replace(/```[\s\S]*?```/g, '').trim().split('\n')[0].slice(0, 200);
    } catch {
      return this.fallbackReasoning(candidate, score);
    }
  }

  // ── Provider router with fallback ────────────────────────────────

  private async callWithFallback(system: string, user: string): Promise<string> {
    const providers: LlmProvider[] = [this.provider, this.fallbackProvider].filter(
      (p, i, arr) => p !== 'none' && arr.indexOf(p) === i,
    );

    let lastError: Error | null = null;

    for (const provider of providers) {
      try {
        const result = await this.callProvider(provider, system, user);
        if (result?.trim()) return result;
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(`Provider ${provider} failed: ${lastError.message} — trying next`);
      }
    }

    throw lastError ?? new Error('All LLM providers failed');
  }

  private async callProvider(provider: LlmProvider, system: string, user: string): Promise<string> {
    switch (provider) {
      case 'groq':
        if (!this.groqKey) throw new Error('GROQ_API_KEY not set');
        return this.callGroqWithSelfHeal(system, user);

      case 'gemini':
        if (!this.geminiKey) throw new Error('GEMINI_API_KEY not set');
        return this.callGeminiWithSelfHeal(system, user);

      case 'ollama':
        return callOllama(this.ollamaUrl, this.ollamaModel, system, user, this.maxTokens);

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /** Calls Groq; if the model itself was rejected (deprecated mid-run),
   *  advances to the next candidate and retries once before giving up. */
  private async callGroqWithSelfHeal(system: string, user: string): Promise<string> {
    try {
      return await callGroq(this.groqKey, this.groqModel, system, user, this.maxTokens);
    } catch (err: any) {
      const msg = err?.error?.error?.message || err.message || '';
      if (isModelErrorMessage(msg) && this.groqCandidateIdx < GROQ_MODEL_CANDIDATES.length - 1) {
        this.groqCandidateIdx++;
        const nextModel = GROQ_MODEL_CANDIDATES[this.groqCandidateIdx];
        this.logger.warn(`Groq model "${this.groqModel}" rejected — retrying once with "${nextModel}"`);
        this.groqModel = nextModel;
        return callGroq(this.groqKey, this.groqModel, system, user, this.maxTokens);
      }
      throw err;
    }
  }

  /** Same self-healing pattern for Gemini. */
  private async callGeminiWithSelfHeal(system: string, user: string): Promise<string> {
    try {
      return await callGemini(this.geminiKey, this.geminiModel, system, user);
    } catch (err: any) {
      const msg = err.message || '';
      if (isModelErrorMessage(msg) && this.geminiCandidateIdx < GEMINI_MODEL_CANDIDATES.length - 1) {
        this.geminiCandidateIdx++;
        const nextModel = GEMINI_MODEL_CANDIDATES[this.geminiCandidateIdx];
        this.logger.warn(`Gemini model "${this.geminiModel}" rejected — retrying once with "${nextModel}"`);
        this.geminiModel = nextModel;
        return callGemini(this.geminiKey, this.geminiModel, system, user);
      }
      throw err;
    }
  }

  // ── Prompt builders ──────────────────────────────────────────────

  private systemPrompt(): string {
    return (
      'You are an expert technical recruiter evaluating candidates for a Senior AI Engineer role. ' +
      'You understand the difference between genuine ML engineers and keyword-stuffed profiles. ' +
      'Respond ONLY with valid JSON — no markdown fences, no extra text before or after.'
    );
  }

  private buildBatchPrompt(
    candidates: Array<{ candidate: RawCandidate; deterministicScore: ScoreBreakdown }>,
  ): string {
    const list = candidates
      .map(
        ({ candidate: c, deterministicScore: d }) =>
          `${c.candidate_id}: ${c.profile.current_title} @ ${c.profile.current_company} | ` +
          `${c.profile.years_of_experience}y | ${c.profile.location}, ${c.profile.country}\n` +
          `Skills: ${c.skills.slice(0, 8).map((s) => `${s.name}(${s.proficiency})`).join(', ')}\n` +
          `Career: ${c.career_history.slice(0, 3).map((e) => `${e.title}@${e.company}(${e.duration_months}mo)`).join(' → ')}\n` +
          `Signals: open=${c.redrob_signals.open_to_work_flag}, ` +
          `last_active=${c.redrob_signals.last_active_date}, ` +
          `response_rate=${c.redrob_signals.recruiter_response_rate?.toFixed(2)}, ` +
          `notice=${c.redrob_signals.notice_period_days}d\n` +
          `DetScore: ${d.total.toFixed(1)}/100`,
      )
      .join('\n\n');

    return (
      `JD: ${JD_CONTEXT}\n\n` +
      `Evaluate these ${candidates.length} candidates. Adjust deterministic score ±20 based on:\n` +
      `- UP: production system evidence in descriptions, strong product company history\n` +
      `- DOWN: inactive >90d (last_active date), response_rate<0.3, consulting-only career\n\n` +
      `${list}\n\n` +
      `Respond with ONLY this JSON structure:\n` +
      `{"evaluations":[{"candidate_id":"CAND_XXXXXXX","llm_score":75.5,"reasoning":"1-2 sentences max 50 words"}]}`
    );
  }

  // ── Response parsing ─────────────────────────────────────────────

  private parseEvaluations(raw: string, candidates: RawCandidate[]): LlmEvaluation[] {
    try {
      const cleaned = raw
        .replace(/```json[\s\S]*?```/g, (m) => m.replace(/```json|```/g, ''))
        .replace(/```/g, '')
        .trim();

      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in response');

      const parsed = JSON.parse(jsonMatch[0]);
      const evals: any[] = parsed.evaluations ?? [];

      return evals.map((e) => ({
        candidate_id: e.candidate_id,
        llmScore: Math.max(0, Math.min(100, parseFloat(e.llm_score) || 0)),
        reasoning: String(e.reasoning || '').slice(0, 200),
      }));
    } catch (err) {
      this.logger.warn(`Parse failed (${err.message}) — using deterministic fallbacks`);
      return candidates.map((c) => ({
        candidate_id: c.candidate_id,
        llmScore: 50,
        reasoning: `${c.profile.years_of_experience}y ${c.profile.current_title} evaluated via automated pipeline.`,
      }));
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private candidateSummary(c: RawCandidate): string {
    return (
      `${c.profile.current_title} | ${c.profile.years_of_experience}y | ${c.profile.location}, ${c.profile.country}\n` +
      `Skills: ${c.skills.slice(0, 8).map((s) => s.name).join(', ')}\n` +
      `Career: ${c.career_history.slice(0, 3).map((e) => `${e.title} at ${e.company} (${e.duration_months}mo)`).join('; ')}`
    );
  }

  private fallbackReasoning(c: RawCandidate, score: ScoreBreakdown): string {
    const top3 = c.skills.slice(0, 3).map((s) => s.name).join(', ');
    return `${c.profile.years_of_experience}y exp ${c.profile.current_title} with ${top3}; composite score ${score.total.toFixed(1)}/100.`;
  }
}