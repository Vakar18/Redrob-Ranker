#!/usr/bin/env node
/**
 * scripts/generate-submission.js
 *
 * Full ranking pipeline in plain Node.js — no TypeScript, no ts-node needed.
 * Run directly: node scripts/generate-submission.js
 *
 * FREE LLM providers (pick any):
 *   --provider groq    → console.groq.com (free, fast)
 *   --provider gemini  → aistudio.google.com/app/apikey (free)
 *   --provider ollama  → local model, zero cost, zero internet
 *   --no-llm           → pure deterministic scoring, no external calls
 *
 * MODEL AUTO-DISCOVERY:
 *   Groq and Gemini both retire model names frequently (sometimes monthly).
 *   Rather than hardcoding one model name that can break overnight, this
 *   script queries each provider's live /models list at startup and picks
 *   the first one that responds successfully from a preference-ordered
 *   candidate list. You can still force a specific model with
 *   GROQ_MODEL= / GEMINI_MODEL= if you want to skip discovery.
 *
 * Examples:
 *   GROQ_API_KEY=gsk_... node scripts/generate-submission.js --provider groq
 *   GEMINI_API_KEY=AIza... node scripts/generate-submission.js --provider gemini
 *   node scripts/generate-submission.js --provider ollama
 *   node scripts/generate-submission.js --no-llm --out ./team_name.csv
 *   GROQ_API_KEY=gsk_... GEMINI_API_KEY=AIza... \
 *     node scripts/generate-submission.js --provider groq --fallback gemini
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const mongoose = require('mongoose');

// ── CLI ───────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const noLlm    = args.includes('--no-llm');
const provider = getArg('--provider') ?? process.env.LLM_PROVIDER ?? 'groq';
const fallback = getArg('--fallback') ?? process.env.LLM_FALLBACK_PROVIDER ?? 'gemini';
const outFile  = getArg('--out') ?? './submission.csv';
const mongoUri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/redrob_ranker';
const TOP_N    = 100;
const LLM_TOP  = 300;
const LLM_BATCH= 8;

const GROQ_KEY    = process.env.GROQ_API_KEY ?? '';
// If GROQ_MODEL is set explicitly, it's used as-is (no discovery).
// Otherwise these are tried in order at startup — first one that
// actually exists on your account/region wins.
const GROQ_MODEL_OVERRIDE = process.env.GROQ_MODEL ?? null;
const GROQ_MODEL_CANDIDATES = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-4-scout',
  'qwen3-32b',
];

const GEMINI_KEY  = process.env.GEMINI_API_KEY ?? '';
const GEMINI_MODEL_OVERRIDE = process.env.GEMINI_MODEL ?? null;
const GEMINI_MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
];

const OLLAMA_URL  = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL= process.env.OLLAMA_MODEL   ?? 'llama3.1';

// Resolved at runtime by discoverModel() — see main()
let GROQ_MODEL   = GROQ_MODEL_OVERRIDE;
let GEMINI_MODEL = GEMINI_MODEL_OVERRIDE;

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

// ── Scoring constants (JD-derived) ───────────────────────────────
const HARD_SKILLS = new Set([
  'embeddings','sentence-transformers','openai embeddings','bge','e5',
  'vector database','vector search','pinecone','weaviate','qdrant',
  'milvus','faiss','opensearch','elasticsearch','hybrid search',
  'ndcg','mrr','map','a/b testing','ranking evaluation','python',
]);
const SOFT_SKILLS = new Set([
  'lora','qlora','peft','fine-tuning llms','fine-tuning',
  'learning to rank','xgboost','lightgbm','nlp','information retrieval',
  'bm25','sparse retrieval','dense retrieval','reranking','re-ranking',
  'recommendation systems','search','ranking','distributed systems',
]);
const NEGATIVE_SKILLS = new Set([
  'computer vision','image classification','speech recognition','tts',
  'speech synthesis','image segmentation','object detection','robotics','lidar',
]);
const CONSULTING = new Set([
  'tcs','tata consultancy','infosys','wipro','accenture',
  'cognizant','capgemini','hcl','tech mahindra','mphasis',
]);
const TARGET_CITIES = ['noida','pune','delhi','ncr','hyderabad','mumbai','gurgaon','gurugram','bangalore','bengaluru'];

// ── Scoring helpers ───────────────────────────────────────────────
function daysSince(d) {
  if (!d) return 999;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}
function profMult(p) {
  return ({beginner:0.4,intermediate:0.7,advanced:0.9,expert:1.0})[p] ?? 0.5;
}

// ── Honeypot detection ────────────────────────────────────────────
function detectHoneypot(c) {
  const expertCount = (c.skills||[]).filter(s => s.proficiency === 'expert').length;
  if (expertCount > 20) return 'Too many expert skills (>20) — keyword stuffer';

  const nonTechTitles = ['marketing','sales','hr','finance','accountant','lawyer','operations'];
  const title = (c.profile?.current_title||'').toLowerCase();
  const hasAI = (c.skills||[]).some(s => HARD_SKILLS.has(s.name.toLowerCase()));
  if (nonTechTitles.some(t => title.includes(t)) && hasAI) return 'Title/skills mismatch';

  return null;
}

// ── Hard disqualifiers ────────────────────────────────────────────
function checkDisqualifiers(c) {
  if ((c.profile?.years_of_experience ?? 0) < 3.5) return 'Under 4 years experience';

  const hist = c.career_history || [];
  if (hist.length > 0 && hist.every(j => Array.from(CONSULTING).some(f => j.company?.toLowerCase().includes(f)))) {
    return 'Entire career at consulting/outsourcing firms';
  }

  const neg = (c.skills||[]).filter(s => NEGATIVE_SKILLS.has(s.name.toLowerCase())).length;
  const pos = (c.skills||[]).filter(s => HARD_SKILLS.has(s.name.toLowerCase()) || SOFT_SKILLS.has(s.name.toLowerCase())).length;
  if (neg > 5 && neg > pos * 2) return 'Primary domain is CV/Speech/Robotics';

  return null;
}

// ── Dimension: Skill Match (35%) ──────────────────────────────────
function scoreSkillMatch(c) {
  const text = [
    ...(c.skills||[]).map(s => s.name.toLowerCase()),
    ...(c.career_history||[]).map(e => (e.description||'').toLowerCase()),
    (c.profile?.headline||'').toLowerCase(),
    (c.profile?.summary||'').toLowerCase(),
  ].join(' ');

  let hard = 0;
  for (const sk of HARD_SKILLS) {
    if (text.includes(sk)) {
      const m = (c.skills||[]).find(s => s.name.toLowerCase().includes(sk));
      hard += m ? profMult(m.proficiency) * 15 : 8;
    }
  }

  let soft = 0;
  for (const sk of SOFT_SKILLS) {
    if (text.includes(sk)) {
      const m = (c.skills||[]).find(s => s.name.toLowerCase().includes(sk));
      soft += m ? profMult(m.proficiency) * 5 : 3;
    }
  }

  const assessScores = c.redrob_signals?.skill_assessment_scores ?? {};
  const relevant = Object.entries(assessScores).filter(([k]) =>
    [...HARD_SKILLS,...SOFT_SKILLS].some(s => k.toLowerCase().includes(s))
  );
  const bonus = relevant.length > 0
    ? (relevant.reduce((a,[,v]) => a + v, 0) / relevant.length / 100) * 15
    : 0;

  return Math.min(Math.min(hard, 60) + Math.min(soft, 25) + bonus, 100);
}

// ── Dimension: Career Fit (30%) ───────────────────────────────────
function scoreCareerFit(c) {
  let score = 0;
  const yoe   = c.profile?.years_of_experience ?? 0;
  const hist  = c.career_history || [];
  const total = hist.reduce((a,b) => a + (b.duration_months||0), 0) || 1;

  // YoE alignment (sweet spot 6-8y for this JD)
  if      (yoe >= 6 && yoe <= 8) score += 25;
  else if (yoe >= 5)              score += 20;
  else if (yoe >= 4)              score += 12;
  else                            score +=  5;

  // Product vs services ratio
  const svcInds = ['IT Services','Consulting','BPO','Outsourcing'];
  const prodMo  = hist
    .filter(j => !svcInds.some(i => j.industry?.includes(i)) && !Array.from(CONSULTING).some(f => j.company?.toLowerCase().includes(f)))
    .reduce((a,b) => a + (b.duration_months||0), 0);
  score += (prodMo / total) * 20;

  // Production deployment evidence in descriptions
  const prodKw  = ['production','deployed','shipped','launched','scale','users','live','latency','million'];
  const evidence= hist.filter(j => prodKw.some(kw => j.description?.toLowerCase().includes(kw))).length;
  score += Math.min(evidence * 5, 20);

  // Average tenure (JD wants stayers, not hoppers)
  const avgTenure = total / (hist.length || 1);
  if      (avgTenure >= 24) score += 15;
  else if (avgTenure >= 18) score += 10;
  else if (avgTenure >= 12) score +=  5;
  else                      score -=  5;

  // Education tier
  const premEd = (c.education||[]).some(e => ['tier_1','tier_2'].includes(e.tier));
  score += premEd ? 10 : 3;

  // GitHub activity
  const gh = c.redrob_signals?.github_activity_score ?? -1;
  if (gh > 0) score += (gh / 100) * 10;

  return Math.min(Math.max(score, 0), 100);
}

// ── Dimension: Behavioral signals (20%) ───────────────────────────
function scoreBehavioral(c) {
  const s = c.redrob_signals ?? {};
  let score = 0;

  score += ((s.profile_completeness_score ?? 0) / 100) * 15;

  const days = daysSince(s.last_active_date);
  if      (days <=   7) score += 20;
  else if (days <=  30) score += 15;
  else if (days <=  90) score +=  8;
  else if (days <= 180) score +=  3;
  // > 180 days → 0 bonus (effectively unavailable per JD)

  score += (s.recruiter_response_rate     ?? 0) * 15;
  score += (s.interview_completion_rate   ?? 0) * 15;
  score += Math.min((s.saved_by_recruiters_30d  ?? 0) / 10,  1) * 10;
  score += Math.min((s.profile_views_received_30d ?? 0) / 50, 1) * 10;
  score += Math.min((s.endorsements_received ?? 0) / 100, 1) * 10;
  if (s.verified_email)     score += 2;
  if (s.verified_phone)     score += 2;
  if (s.linkedin_connected) score += 1;

  return Math.min(Math.max(score, 0), 100);
}

// ── Dimension: Availability (15%) ─────────────────────────────────
function scoreAvailability(c) {
  const s   = c.redrob_signals ?? {};
  let score = 0;

  score += s.open_to_work_flag ? 30 : 5;

  const np = s.notice_period_days ?? 90;
  if      (np === 0)  score += 30;
  else if (np <= 15)  score += 28;
  else if (np <= 30)  score += 22;
  else if (np <= 60)  score += 12;
  else                score +=  4;

  const loc      = ((c.profile?.location ?? '') + ' ' + (c.profile?.country ?? '')).toLowerCase();
  const inIndia  = c.profile?.country === 'India' || loc.includes('india');
  const inTarget = TARGET_CITIES.some(city => loc.includes(city));

  if      (inTarget)                        score += 25;
  else if (inIndia && s.willing_to_relocate)score += 18;
  else if (inIndia)                         score += 10;
  else if (s.willing_to_relocate)           score +=  5;

  const mode = s.preferred_work_mode ?? '';
  if      (mode === 'hybrid' || mode === 'flexible') score += 15;
  else if (mode === 'onsite')                        score += 10;
  else                                               score +=  5;

  return Math.min(Math.max(score, 0), 100);
}

// ── Score a single candidate ──────────────────────────────────────
function scoreCandidate(c) {
  const hp = detectHoneypot(c);
  if (hp) return { candidate_id: c.candidate_id, breakdown: zero(), isHoneypot: true, disqualificationReason: hp, reasoning: '', raw: c };

  const dq = checkDisqualifiers(c);
  if (dq) return { candidate_id: c.candidate_id, breakdown: zero(), isHoneypot: false, disqualificationReason: dq, reasoning: '', raw: c };

  const skillMatch   = scoreSkillMatch(c);
  const careerFit    = scoreCareerFit(c);
  const behavioral   = scoreBehavioral(c);
  const availability = scoreAvailability(c);
  const total        = skillMatch*0.35 + careerFit*0.30 + behavioral*0.20 + availability*0.15;

  return {
    candidate_id: c.candidate_id,
    breakdown: {
      skillMatch:   Math.round(skillMatch   * 10) / 10,
      careerFit:    Math.round(careerFit    * 10) / 10,
      behavioral:   Math.round(behavioral   * 10) / 10,
      availability: Math.round(availability * 10) / 10,
      total:        Math.round(total * 100) / 100,
    },
    isHoneypot: false,
    disqualificationReason: null,
    reasoning: '',
    raw: c,
  };
}

function zero() { return { skillMatch:0, careerFit:0, behavioral:0, availability:0, total:0 }; }

// ── Model auto-discovery ──────────────────────────────────────────
// Provider model catalogs change frequently (sometimes monthly).
// Instead of trusting one hardcoded name, ask the provider what's
// actually live right now and pick the first usable candidate.

async function discoverGroqModel() {
  if (GROQ_MODEL) return GROQ_MODEL; // explicit override wins
  if (!GROQ_KEY) return GROQ_MODEL_CANDIDATES[0]; // nothing to query against

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const liveIds = new Set((data.data || []).map(m => m.id));

    for (const candidate of GROQ_MODEL_CANDIDATES) {
      if (liveIds.has(candidate)) {
        console.log(`  ✅ Groq model auto-selected: ${candidate}`);
        return candidate;
      }
    }
    // None of our preferred candidates exist — grab any chat-capable model
    const anyModel = (data.data || []).find(m => !/whisper|tts|guard/i.test(m.id));
    if (anyModel) {
      console.log(`  ⚠️  None of the preferred Groq models are live — using: ${anyModel.id}`);
      return anyModel.id;
    }
  } catch (e) {
    console.warn(`  ⚠️  Groq model discovery failed (${e.message}) — falling back to first candidate`);
  }
  return GROQ_MODEL_CANDIDATES[0];
}

async function discoverGeminiModel() {
  if (GEMINI_MODEL) return GEMINI_MODEL; // explicit override wins
  if (!GEMINI_KEY) return GEMINI_MODEL_CANDIDATES[0];

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const liveIds = new Set((data.models || []).map(m => m.name.replace('models/', '')));

    for (const candidate of GEMINI_MODEL_CANDIDATES) {
      if (liveIds.has(candidate)) {
        console.log(`  ✅ Gemini model auto-selected: ${candidate}`);
        return candidate;
      }
    }
    const anyFlash = [...liveIds].find(id => /flash/i.test(id) && !/image|tts|embed/i.test(id));
    if (anyFlash) {
      console.log(`  ⚠️  None of the preferred Gemini models are live — using: ${anyFlash}`);
      return anyFlash;
    }
  } catch (e) {
    console.warn(`  ⚠️  Gemini model discovery failed (${e.message}) — falling back to first candidate`);
  }
  return GEMINI_MODEL_CANDIDATES[0];
}

// ── LLM providers ─────────────────────────────────────────────────

// Track which candidate index each provider is currently on, so a
// mid-run deprecation can advance to the next one without restarting.
let groqCandidateIdx   = -1; // -1 = "use discovered/override GROQ_MODEL as-is"
let geminiCandidateIdx = -1;

function isModelErrorMessage(msg) {
  return /decommissioned|deprecated|not found|not supported|invalid.?model/i.test(msg || '');
}

async function callGroq(system, user) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set. Free key at https://console.groq.com');
  const Groq = require('groq-sdk');
  const client = new Groq({ apiKey: GROQ_KEY });

  try {
    const res = await client.chat.completions.create({
      model: GROQ_MODEL, max_tokens: 2048, temperature: 0.1,
      messages: [{ role:'system', content:system }, { role:'user', content:user }],
    });
    return res.choices[0]?.message?.content ?? '';
  } catch (e) {
    const msg = e?.error?.error?.message || e.message || '';
    if (isModelErrorMessage(msg) && groqCandidateIdx < GROQ_MODEL_CANDIDATES.length - 1) {
      groqCandidateIdx++;
      const nextModel = GROQ_MODEL_CANDIDATES[groqCandidateIdx];
      console.warn(`\n  ⚠️  Groq model "${GROQ_MODEL}" rejected — retrying once with "${nextModel}"`);
      GROQ_MODEL = nextModel;
      const res = await client.chat.completions.create({
        model: GROQ_MODEL, max_tokens: 2048, temperature: 0.1,
        messages: [{ role:'system', content:system }, { role:'user', content:user }],
      });
      return res.choices[0]?.message?.content ?? '';
    }
    throw e;
  }
}

async function callGemini(system, user) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set. Free key at https://aistudio.google.com/app/apikey');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);

  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: system });
    const result = await model.generateContent(user);
    return result.response.text();
  } catch (e) {
    const msg = e.message || '';
    if (isModelErrorMessage(msg) && geminiCandidateIdx < GEMINI_MODEL_CANDIDATES.length - 1) {
      geminiCandidateIdx++;
      const nextModel = GEMINI_MODEL_CANDIDATES[geminiCandidateIdx];
      console.warn(`\n  ⚠️  Gemini model "${GEMINI_MODEL}" rejected — retrying once with "${nextModel}"`);
      GEMINI_MODEL = nextModel;
      const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: system });
      const result = await model.generateContent(user);
      return result.response.text();
    }
    throw e;
  }
}

async function callOllama(system, user) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL, stream: false,
      options: { num_predict: 2048, temperature: 0.1 },
      messages: [{ role:'system', content:system }, { role:'user', content:user }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.message?.content ?? '';
}

async function callLlm(system, user) {
  const chain = [provider, fallback].filter((p, i, a) => p !== 'none' && a.indexOf(p) === i);
  let lastErr = null;
  for (const p of chain) {
    try {
      if (p === 'groq')   return await callGroq(system, user);
      if (p === 'gemini') return await callGemini(system, user);
      if (p === 'ollama') return await callOllama(system, user);
    } catch (e) {
      lastErr = e;
      console.warn(`\n  ⚠️  ${p} failed: ${e.message} — trying next`);
    }
  }
  throw lastErr ?? new Error('All LLM providers failed');
}

function parseEvals(raw, ids) {
  const out = new Map();
  try {
    const cleaned = raw.replace(/```json[\s\S]*?```/g, m => m.replace(/```json|```/g, '')).replace(/```/g,'').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object in response');
    const parsed  = JSON.parse(match[0]);
    for (const e of (parsed.evaluations ?? [])) {
      out.set(e.candidate_id, {
        llmScore:  Math.max(0, Math.min(100, parseFloat(e.llm_score) || 0)),
        reasoning: String(e.reasoning || '').slice(0, 200),
      });
    }
  } catch (e) {
    console.warn(`  ⚠️  Parse error: ${e.message}`);
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function llmRerank(candidates) {
  const results = new Map();
  if (noLlm || candidates.length === 0) return results;

  const system =
    'You are an expert technical recruiter evaluating Senior AI Engineer candidates for Redrob AI. ' +
    'Respond ONLY with valid JSON — no markdown fences, no text outside the JSON object.';

  for (let i = 0; i < candidates.length; i += LLM_BATCH) {
    const batch = candidates.slice(i, i + LLM_BATCH);

    const candidateList = batch.map(c => {
      const r = c.raw;
      return [
        `${c.candidate_id}: ${r.profile?.current_title} @ ${r.profile?.current_company} | ${r.profile?.years_of_experience}y | ${r.profile?.location}`,
        `Skills: ${(r.skills||[]).slice(0,8).map(s=>s.name).join(', ')}`,
        `Career: ${(r.career_history||[]).slice(0,3).map(e=>`${e.title}@${e.company}(${e.duration_months}mo)`).join(' → ')}`,
        `Signals: open=${r.redrob_signals?.open_to_work_flag}, last_active=${r.redrob_signals?.last_active_date}, response_rate=${(r.redrob_signals?.recruiter_response_rate??0).toFixed(2)}, notice=${r.redrob_signals?.notice_period_days}d`,
        `DetScore: ${c.breakdown.total.toFixed(1)}/100`,
      ].join('\n');
    }).join('\n\n');

    const user =
      `JD: Senior AI Engineer, Redrob AI (Pune/Noida, India). ` +
      `REQUIRES: production embeddings retrieval, vector DBs (Pinecone/FAISS/Qdrant/Weaviate), Python, eval frameworks (NDCG/MRR). ` +
      `Target: 5-9y at product companies. ` +
      `DISQUALIFIERS: consulting-only career (TCS/Infosys/Wipro etc.), CV/speech primary, <4y exp.\n\n` +
      `Evaluate these candidates. Adjust DetScore by ±20 based on:\n` +
      `- UP: clear production system evidence in career descriptions\n` +
      `- DOWN: last_active > 90 days ago, response_rate < 0.3, consulting-only career\n\n` +
      `${candidateList}\n\n` +
      `Return ONLY this JSON:\n` +
      `{"evaluations":[{"candidate_id":"CAND_XXXXXXX","llm_score":75.5,"reasoning":"1-2 sentences max 50 words specific to their real experience"}]}`;

    try {
      const raw    = await callLlm(system, user);
      const parsed = parseEvals(raw, batch.map(c => c.candidate_id));
      parsed.forEach((v, k) => results.set(k, v));
    } catch (e) {
      console.warn(`\n  ⚠️  LLM batch ${Math.floor(i/LLM_BATCH)+1} fully failed: ${e.message}`);
    }

    process.stdout.write(`\r  🤖 LLM re-ranking: ${Math.min(i+LLM_BATCH,candidates.length)}/${candidates.length} `);

    // Respect free-tier rate limits
    if (provider === 'gemini') await sleep(1100); // 60 req/min
    else                       await sleep(300);
  }
  console.log();
  return results;
}

// ── Reasoning fallback ────────────────────────────────────────────
function buildReasoning(c, llm) {
  if (llm?.reasoning) return llm.reasoning;
  const r    = c.raw;
  const top3 = (r.skills||[]).slice(0,3).map(s=>s.name).join(', ');
  return `${r.profile?.years_of_experience}y exp ${r.profile?.current_title} with ${top3}; skill ${c.breakdown.skillMatch.toFixed(0)}/100, career ${c.breakdown.careerFit.toFixed(0)}/100.`;
}

// ── CSV writer ────────────────────────────────────────────────────
function writeCsv(rows) {
  const lines = ['candidate_id,rank,score,reasoning'];
  for (const r of rows) {
    const safe = r.reasoning.replace(/"/g,"'").replace(/[\r\n,]/g,' ').slice(0, 200);
    lines.push(`${r.candidate_id},${r.rank},${r.score.toFixed(4)},"${safe}"`);
  }
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf-8');
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Redrob Candidate Ranker\n');
  console.log(`  Provider:  ${noLlm ? 'NONE (pure deterministic)' : `${provider}${fallback !== 'none' ? ` → ${fallback} (fallback)` : ''}`}`);
  console.log(`  Output:    ${path.resolve(outFile)}`);
  console.log(`  MongoDB:   ${mongoUri}\n`);

  if (!noLlm) {
    if (provider === 'groq'   && !GROQ_KEY)   console.warn('  ⚠️  GROQ_API_KEY not set');
    if (provider === 'gemini' && !GEMINI_KEY) console.warn('  ⚠️  GEMINI_API_KEY not set');
    if (provider === 'ollama')                console.log(`  Ollama: ${OLLAMA_URL} model=${OLLAMA_MODEL}`);

    // Resolve which model actually exists on each provider right now
    const needsGroq   = provider === 'groq'   || fallback === 'groq';
    const needsGemini = provider === 'gemini' || fallback === 'gemini';
    console.log('\n🔎 Checking live model availability...');
    if (needsGroq   && GROQ_KEY)   GROQ_MODEL   = await discoverGroqModel();
    if (needsGemini && GEMINI_KEY) GEMINI_MODEL = await discoverGeminiModel();
  }

  // ── Connect ──
  console.log('\n🔌 Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('✅ Connected\n');

  const schema = new mongoose.Schema({}, { strict: false, timestamps: true });
  const Model  = mongoose.models?.Candidate ?? mongoose.model('Candidate', schema, 'candidates');

  // ── 1. Deterministic scoring ──
  console.log('⚙️  Scoring all candidates...');
  const t0    = Date.now();
  const BATCH = 500;
  const total = await Model.countDocuments();

  if (total === 0) {
    console.error('❌ No candidates in DB. Run the ingest script first.');
    process.exit(1);
  }

  const scored = [];
  let hp = 0, dq = 0;

  for (let skip = 0; skip < total; skip += BATCH) {
    const batch = await Model.find({}, null, { lean: true }).skip(skip).limit(BATCH).exec();
    for (const c of batch) {
      const r = scoreCandidate(c);
      scored.push(r);
      if (r.isHoneypot)              hp++;
      else if (r.disqualificationReason) dq++;
    }
    process.stdout.write(
      `\r  Scored: ${Math.min(skip+BATCH,total).toLocaleString()}/${total.toLocaleString()} | Honeypots: ${hp} | Disqualified: ${dq}  `
    );
  }
  console.log(`\n  ⏱️  Scoring done in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // ── 2. Sort eligible candidates ──
  const eligible = scored
    .filter(c => !c.isHoneypot && !c.disqualificationReason)
    .sort((a, b) => {
      const d = b.breakdown.total - a.breakdown.total;
      return Math.abs(d) > 0.001 ? d : a.candidate_id.localeCompare(b.candidate_id);
    });

  console.log(`📊 Eligible: ${eligible.length}/${total} (${hp} honeypots, ${dq} disqualified)\n`);

  // ── 3. LLM re-ranking ──
  let llmMap = new Map();
  if (!noLlm) {
    const topForLlm = eligible.slice(0, LLM_TOP);
    console.log(`🤖 LLM re-ranking top ${topForLlm.length} candidates (batch=${LLM_BATCH})...`);
    llmMap = await llmRerank(topForLlm);
    console.log(`  ✅ LLM scores: ${llmMap.size} candidates\n`);
  }

  // ── 4. Blend + select top 100 ──
  const finalRows = eligible
    .slice(0, LLM_TOP)
    .map(c => {
      const llm   = llmMap.get(c.candidate_id);
      const score = llm
        ? c.breakdown.total * 0.6 + llm.llmScore * 0.4
        : c.breakdown.total;
      return { candidate_id: c.candidate_id, score: Math.round(score * 10000) / 10000, reasoning: buildReasoning(c, llm) };
    })
    .sort((a, b) => {
      const d = b.score - a.score;
      return Math.abs(d) > 0.0001 ? d : a.candidate_id.localeCompare(b.candidate_id);
    })
    .slice(0, TOP_N)
    .map((c, i) => ({ ...c, rank: i + 1 }));

  // Enforce non-increasing scores (required by validate_submission.py)
  for (let i = 1; i < finalRows.length; i++) {
    if (finalRows[i].score > finalRows[i-1].score) {
      finalRows[i].score = Math.round((finalRows[i-1].score - 0.0001) * 10000) / 10000;
    }
  }

  // ── 5. Write CSV ──
  writeCsv(finalRows);

  const elapsed = ((Date.now()-t0)/1000).toFixed(1);
  console.log(`✅ CSV written → ${path.resolve(outFile)}`);
  console.log(`   Rows: ${finalRows.length}`);
  console.log(`   Score range: ${finalRows[finalRows.length-1]?.score.toFixed(4)} – ${finalRows[0]?.score.toFixed(4)}`);
  console.log('\n🏆 Top 5:');
  finalRows.slice(0,5).forEach(c => console.log(`   #${c.rank}  ${c.candidate_id}  →  ${c.score.toFixed(2)}`));
  console.log(`\n⏱️  Total time: ${elapsed}s`);
  console.log(`\n👉 Validate: python3 validate_submission.py ${path.resolve(outFile)}`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
}); 