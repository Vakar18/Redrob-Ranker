import { Injectable, Logger } from '@nestjs/common';
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

// ────────────────────────────────────────────────────────────────
// Provider implementations
// ────────────────────────────────────────────────────────────────

/** Groq — free tier, very fast (llama3-70b) */
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

/** Google Gemini — free tier (1500 req/day, 60 req/min) */
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

/** Ollama — fully local, zero cost, no internet required */
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
  const data = await response.json() as any;
  return data?.message?.content ?? '';
}

// ────────────────────────────────────────────────────────────────
// Main injectable service
// ────────────────────────────────────────────────────────────────

@Injectable()
export class LlmReranker {
  private readonly logger = new Logger(LlmReranker.name);

  private readonly provider: LlmProvider;
  private readonly fallbackProvider: LlmProvider;
  private readonly groqKey: string;
  private readonly groqModel: string;
  private readonly geminiKey: string;
  private readonly geminiModel: string;
  private readonly ollamaUrl: string;
  private readonly ollamaModel: string;
  private readonly maxTokens: number;

  constructor(private readonly config: ConfigService) {
    this.provider        = (config.get<string>('llm.provider', 'groq') as LlmProvider);
    this.fallbackProvider= (config.get<string>('llm.fallbackProvider', 'gemini') as LlmProvider);
    this.groqKey         = config.get<string>('llm.groq.apiKey', '');
    this.groqModel       = config.get<string>('llm.groq.model', 'llama3-70b-8192');
    this.geminiKey       = config.get<string>('llm.gemini.apiKey', '');
    this.geminiModel     = config.get<string>('llm.gemini.model', 'gemini-1.5-flash');
    this.ollamaUrl       = config.get<string>('llm.ollama.baseUrl', 'http://localhost:11434');
    this.ollamaModel     = config.get<string>('llm.ollama.model', 'llama3.1');
    this.maxTokens       = config.get<number>('llm.groq.maxTokens', 2048);

    this.logger.log(
      `LLM provider: ${this.provider} → fallback: ${this.fallbackProvider}`,
    );
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
  async generateReasoning(
    candidate: RawCandidate,
    score: ScoreBreakdown,
  ): Promise<string> {
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
    const providers: LlmProvider[] = [
      this.provider,
      this.fallbackProvider,
    ].filter((p, i, arr) => p !== 'none' && arr.indexOf(p) === i);

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

  private async callProvider(
    provider: LlmProvider,
    system: string,
    user: string,
  ): Promise<string> {
    switch (provider) {
      case 'groq':
        if (!this.groqKey) throw new Error('GROQ_API_KEY not set');
        return callGroq(this.groqKey, this.groqModel, system, user, this.maxTokens);

      case 'gemini':
        if (!this.geminiKey) throw new Error('GEMINI_API_KEY not set');
        return callGemini(this.geminiKey, this.geminiModel, system, user);

      case 'ollama':
        return callOllama(this.ollamaUrl, this.ollamaModel, system, user, this.maxTokens);

      default:
        throw new Error(`Unknown provider: ${provider}`);
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
    const list = candidates.map(({ candidate: c, deterministicScore: d }) =>
      `${c.candidate_id}: ${c.profile.current_title} @ ${c.profile.current_company} | ` +
      `${c.profile.years_of_experience}y | ${c.profile.location}, ${c.profile.country}\n` +
      `Skills: ${c.skills.slice(0, 8).map((s) => `${s.name}(${s.proficiency})`).join(', ')}\n` +
      `Career: ${c.career_history.slice(0, 3).map((e) => `${e.title}@${e.company}(${e.duration_months}mo)`).join(' → ')}\n` +
      `Signals: open=${c.redrob_signals.open_to_work_flag}, ` +
      `last_active=${c.redrob_signals.last_active_date}, ` +
      `response_rate=${c.redrob_signals.recruiter_response_rate?.toFixed(2)}, ` +
      `notice=${c.redrob_signals.notice_period_days}d\n` +
      `DetScore: ${d.total.toFixed(1)}/100`,
    ).join('\n\n');

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

      // Find the JSON object even if the model added preamble text
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
