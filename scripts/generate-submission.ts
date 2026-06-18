#!/usr/bin/env ts-node
/**
 * scripts/generate-submission.ts
 *
 * End-to-end ranking pipeline — works 100% FREE:
 *
 *   Provider options (in order of recommendation):
 *   1. Groq    — free account at console.groq.com, very fast (llama3-70b)
 *   2. Gemini  — free at aistudio.google.com (1500 req/day, no billing needed)
 *   3. Ollama  — fully local, zero cost, zero internet (install: ollama.com)
 *   4. --no-llm— pure deterministic, no external calls at all
 *
 * Usage examples:
 *   ts-node scripts/generate-submission.ts --provider groq
 *   ts-node scripts/generate-submission.ts --provider gemini
 *   ts-node scripts/generate-submission.ts --provider ollama
 *   ts-node scripts/generate-submission.ts --provider groq --fallback gemini
 *   ts-node scripts/generate-submission.ts --no-llm
 *   ts-node scripts/generate-submission.ts --out ./team_xyz.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';

// ── CLI argument parsing ─────────────────────────────────────────
const args = process.argv.slice(2);
const noLlm         = args.includes('--no-llm');
const provider      = getArg('--provider') ?? process.env.LLM_PROVIDER ?? 'groq';
const fallback      = getArg('--fallback') ?? process.env.LLM_FALLBACK_PROVIDER ?? 'gemini';
const outFile       = getArg('--out') ?? './submission.csv';
const mongoUri      = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/redrob_ranker';
const TOP_N         = 100;
const LLM_TOP       = 300;   // Send top-N through LLM re-ranker
const LLM_BATCH     = 8;     // Candidates per LLM API call (keep small to avoid token limits)

// Provider credentials
const GROQ_KEY      = process.env.GROQ_API_KEY ?? '';
const GROQ_MODEL    = process.env.GROQ_MODEL ?? 'llama3-70b-8192';
const GEMINI_KEY    = process.env.GEMINI_API_KEY ?? '';
const GEMINI_MODEL  = process.env.GEMINI_MODEL ?? 'gemini-1.5-flash';
const OLLAMA_URL    = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL ?? 'llama3.1';

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

// ── Types ────────────────────────────────────────────────────────
interface ScoreBreakdown {
  skillMatch: number;
  careerFit: number;
  behavioral: number;
  availability: number;
  total: number;
}
interface ScoredCandidate {
  candidate_id: string;
  breakdown: ScoreBreakdown;
  isHoneypot: boolean;
  disqualificationReason: string | null;
  reasoning: string;
  raw: any;
}
interface LlmResult { llmScore: number; reasoning: string; }

// ── Scoring constants ────────────────────────────────────────────
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

// ── Deterministic scoring ────────────────────────────────────────
function daysSince(d: string): number {
  if (!d) return 999;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}
function profMult(p: string): number {
  return ({beginner:0.4,intermediate:0.7,advanced:0.9,expert:1.0})[p] ?? 0.5;
}

function detectHoneypot(c: any): string | null {
  const expertCount = (c.skills||[]).filter((s:any)=>s.proficiency==='expert').length;
  if (expertCount > 20) return 'Too many expert skills (>20) — keyword stuffer';
  const nonTechTitles = ['marketing','sales','hr','finance','accountant','lawyer','operations'];
  const title = (c.profile?.current_title||'').toLowerCase();
  const hasAI = (c.skills||[]).some((s:any)=>HARD_SKILLS.has(s.name.toLowerCase()));
  if (nonTechTitles.some(t=>title.includes(t)) && hasAI) return 'Title/skills mismatch';
  return null;
}

function checkDisqualifiers(c: any): string | null {
  if ((c.profile?.years_of_experience??0) < 3.5) return 'Under 4 years experience';
  const hist = c.career_history||[];
  if (hist.length > 0 && hist.every((j:any)=>Array.from(CONSULTING).some(f=>j.company?.toLowerCase().includes(f)))) {
    return 'Entire career at consulting/outsourcing firms';
  }
  const neg = (c.skills||[]).filter((s:any)=>NEGATIVE_SKILLS.has(s.name.toLowerCase())).length;
  const pos = (c.skills||[]).filter((s:any)=>HARD_SKILLS.has(s.name.toLowerCase())||SOFT_SKILLS.has(s.name.toLowerCase())).length;
  if (neg > 5 && neg > pos * 2) return 'Primary domain is CV/Speech/Robotics with negligible NLP/IR';
  return null;
}

function scoreSkillMatch(c: any): number {
  const text = [
    ...(c.skills||[]).map((s:any)=>s.name.toLowerCase()),
    ...(c.career_history||[]).map((e:any)=>(e.description||'').toLowerCase()),
    (c.profile?.headline||'').toLowerCase(),
    (c.profile?.summary||'').toLowerCase(),
  ].join(' ');

  let hard = 0;
  for (const sk of HARD_SKILLS) {
    if (text.includes(sk)) {
      const m = (c.skills||[]).find((s:any)=>s.name.toLowerCase().includes(sk));
      hard += m ? profMult(m.proficiency)*15 : 8;
    }
  }
  let soft = 0;
  for (const sk of SOFT_SKILLS) {
    if (text.includes(sk)) {
      const m = (c.skills||[]).find((s:any)=>s.name.toLowerCase().includes(sk));
      soft += m ? profMult(m.proficiency)*5 : 3;
    }
  }
  const assessScores = c.redrob_signals?.skill_assessment_scores ?? {};
  const relevant = Object.entries(assessScores).filter(([k])=>
    [...HARD_SKILLS,...SOFT_SKILLS].some(s=>k.toLowerCase().includes(s)));
  const bonus = relevant.length>0
    ? (relevant.reduce((a,[,v])=>a+(v as number),0)/relevant.length/100)*15 : 0;
  return Math.min(Math.min(hard,60)+Math.min(soft,25)+bonus, 100);
}

function scoreCareerFit(c: any): number {
  let score = 0;
  const yoe = c.profile?.years_of_experience ?? 0;
  if (yoe>=6&&yoe<=8) score+=25; else if (yoe>=5) score+=20;
  else if (yoe>=4) score+=12; else score+=5;

  const svcInds = ['IT Services','Consulting','BPO','Outsourcing'];
  const total = (c.career_history||[]).reduce((a:number,b:any)=>a+(b.duration_months??0),0)||1;
  const prod  = (c.career_history||[])
    .filter((j:any)=>!svcInds.some(i=>j.industry?.includes(i))&&!Array.from(CONSULTING).some(f=>j.company?.toLowerCase().includes(f)))
    .reduce((a:number,b:any)=>a+(b.duration_months??0),0);
  score += (prod/total)*20;

  const prodKw = ['production','deployed','shipped','launched','scale','users','live','latency','million'];
  const evidence = (c.career_history||[]).filter((j:any)=>prodKw.some(kw=>j.description?.toLowerCase().includes(kw))).length;
  score += Math.min(evidence*5, 20);

  const avg = total/((c.career_history||[]).length||1);
  if (avg>=24) score+=15; else if (avg>=18) score+=10; else if (avg>=12) score+=5; else score-=5;

  const premEd = (c.education||[]).some((e:any)=>['tier_1','tier_2'].includes(e.tier));
  score += premEd ? 10 : 3;

  const gh = c.redrob_signals?.github_activity_score ?? -1;
  if (gh>0) score+=(gh/100)*10;

  return Math.min(Math.max(score,0), 100);
}

function scoreBehavioral(c: any): number {
  const s = c.redrob_signals ?? {};
  let score = 0;
  score += ((s.profile_completeness_score??0)/100)*15;
  const days = daysSince(s.last_active_date);
  if (days<=7) score+=20; else if (days<=30) score+=15; else if (days<=90) score+=8; else if (days<=180) score+=3;
  score += (s.recruiter_response_rate??0)*15;
  score += (s.interview_completion_rate??0)*15;
  score += Math.min((s.saved_by_recruiters_30d??0)/10,1)*10;
  score += Math.min((s.profile_views_received_30d??0)/50,1)*10;
  score += Math.min((s.endorsements_received??0)/100,1)*10;
  if (s.verified_email) score+=2; if (s.verified_phone) score+=2; if (s.linkedin_connected) score+=1;
  return Math.min(Math.max(score,0), 100);
}

function scoreAvailability(c: any): number {
  const s = c.redrob_signals ?? {};
  let score = 0;
  score += s.open_to_work_flag ? 30 : 5;
  const np = s.notice_period_days ?? 90;
  if (np===0) score+=30; else if (np<=15) score+=28; else if (np<=30) score+=22; else if (np<=60) score+=12; else score+=4;
  const loc = ((c.profile?.location??'')+' '+(c.profile?.country??'')).toLowerCase();
  const inIndia = c.profile?.country==='India'||loc.includes('india');
  const inTarget = TARGET_CITIES.some(city=>loc.includes(city));
  if (inTarget) score+=25; else if (inIndia&&s.willing_to_relocate) score+=18; else if (inIndia) score+=10; else if (s.willing_to_relocate) score+=5;
  const mode = s.preferred_work_mode??'';
  if (mode==='hybrid'||mode==='flexible') score+=15; else if (mode==='onsite') score+=10; else score+=5;
  return Math.min(Math.max(score,0), 100);
}

function scoreCandidate(c: any): ScoredCandidate {
  const hp = detectHoneypot(c);
  if (hp) return {candidate_id:c.candidate_id,breakdown:{skillMatch:0,careerFit:0,behavioral:0,availability:0,total:0},isHoneypot:true,disqualificationReason:hp,reasoning:'',raw:c};
  const dq = checkDisqualifiers(c);
  if (dq) return {candidate_id:c.candidate_id,breakdown:{skillMatch:0,careerFit:0,behavioral:0,availability:0,total:0},isHoneypot:false,disqualificationReason:dq,reasoning:'',raw:c};
  const skillMatch   = scoreSkillMatch(c);
  const careerFit    = scoreCareerFit(c);
  const behavioral   = scoreBehavioral(c);
  const availability = scoreAvailability(c);
  const total        = skillMatch*0.35 + careerFit*0.30 + behavioral*0.20 + availability*0.15;
  return {
    candidate_id:c.candidate_id,
    breakdown:{skillMatch:Math.round(skillMatch*10)/10,careerFit:Math.round(careerFit*10)/10,behavioral:Math.round(behavioral*10)/10,availability:Math.round(availability*10)/10,total:Math.round(total*100)/100},
    isHoneypot:false,disqualificationReason:null,reasoning:'',raw:c,
  };
}

// ── LLM provider implementations ─────────────────────────────────

async function callGroq(system: string, user: string): Promise<string> {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set. Get a free key at https://console.groq.com');
  // Dynamic import to avoid requiring the SDK when not needed
  const Groq = (await import('groq-sdk')).default;
  const client = new Groq({ apiKey: GROQ_KEY });
  const res = await client.chat.completions.create({
    model: GROQ_MODEL,
    max_tokens: 2048,
    temperature: 0.1,
    messages: [{ role:'system',content:system },{ role:'user',content:user }],
  });
  return res.choices[0]?.message?.content ?? '';
}

async function callGemini(system: string, user: string): Promise<string> {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set. Get a free key at https://aistudio.google.com/app/apikey');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: system });
  const result = await model.generateContent(user);
  return result.response.text();
}

async function callOllama(system: string, user: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      model: OLLAMA_MODEL, stream: false,
      options:{ num_predict:2048, temperature:0.1 },
      messages:[{role:'system',content:system},{role:'user',content:user}],
    }),
  });
  if (!res.ok) throw new Error(`Ollama responded with HTTP ${res.status}`);
  const data = await res.json() as any;
  return data?.message?.content ?? '';
}

async function callLlm(system: string, user: string): Promise<string> {
  const providers = [provider, fallback].filter((p,i,a)=>p!=='none'&&a.indexOf(p)===i);
  let lastErr: Error | null = null;
  for (const p of providers) {
    try {
      if (p==='groq')   return await callGroq(system, user);
      if (p==='gemini') return await callGemini(system, user);
      if (p==='ollama') return await callOllama(system, user);
    } catch (e: any) {
      lastErr = e;
      console.warn(`  ⚠️  ${p} failed: ${e.message} — trying next provider`);
    }
  }
  throw lastErr ?? new Error('All providers exhausted');
}

function parseEvals(raw: string, ids: string[]): Map<string,LlmResult> {
  const out = new Map<string,LlmResult>();
  try {
    const cleaned = raw.replace(/```json[\s\S]*?```/g,m=>m.replace(/```json|```/g,'')).replace(/```/g,'').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found');
    const parsed = JSON.parse(match[0]);
    for (const e of (parsed.evaluations??[])) {
      out.set(e.candidate_id,{
        llmScore: Math.max(0,Math.min(100,parseFloat(e.llm_score)||0)),
        reasoning: String(e.reasoning||'').slice(0,200),
      });
    }
  } catch { /* use fallback */ }
  return out;
}

async function llmRerank(candidates: ScoredCandidate[]): Promise<Map<string,LlmResult>> {
  const results = new Map<string,LlmResult>();
  if (noLlm || candidates.length===0) return results;

  const system =
    'You are an expert technical recruiter evaluating Senior AI Engineer candidates. ' +
    'Respond ONLY with valid JSON — no markdown, no text outside the JSON.';

  for (let i=0; i<candidates.length; i+=LLM_BATCH) {
    const batch = candidates.slice(i,i+LLM_BATCH);
    const user =
      `JD: Senior AI Engineer at Redrob AI. Requires: production embeddings retrieval, vector DBs (Pinecone/FAISS/Qdrant), Python, eval frameworks. 5-9y exp at product companies. Location: India (Noida/Pune preferred).\n` +
      `DISQUALIFIERS: consulting-only career, CV/speech primary, <4y exp.\n\n` +
      batch.map(c=> {
        const r=c.raw;
        return `${c.candidate_id}: ${r.profile?.current_title} @ ${r.profile?.current_company} | ${r.profile?.years_of_experience}y | ${r.profile?.location}\n` +
          `Skills: ${(r.skills||[]).slice(0,8).map((s:any)=>s.name).join(', ')}\n` +
          `Career: ${(r.career_history||[]).slice(0,3).map((e:any)=>`${e.title}@${e.company}(${e.duration_months}mo)`).join(' → ')}\n` +
          `Signals: open=${r.redrob_signals?.open_to_work_flag}, last_active=${r.redrob_signals?.last_active_date}, response_rate=${r.redrob_signals?.recruiter_response_rate?.toFixed(2)}, notice=${r.redrob_signals?.notice_period_days}d\n` +
          `DetScore: ${c.breakdown.total.toFixed(1)}/100`;
      }).join('\n\n') +
      `\n\nScore each 0-100 (adjust ±20 from DetScore based on semantic understanding).\n` +
      `{"evaluations":[{"candidate_id":"CAND_XXXXXXX","llm_score":75.5,"reasoning":"1-2 sentences max 50 words"}]}`;

    try {
      const raw = await callLlm(system, user);
      const parsed = parseEvals(raw, batch.map(c=>c.candidate_id));
      parsed.forEach((v,k)=>results.set(k,v));
    } catch (e: any) {
      console.warn(`  ⚠️  LLM batch ${Math.floor(i/LLM_BATCH)+1} failed: ${e.message}`);
    }

    process.stdout.write(`\r  LLM re-ranking: ${Math.min(i+LLM_BATCH,candidates.length)}/${candidates.length}`);

    // Respect free-tier rate limits
    if (provider==='gemini') await sleep(1100); // 60 req/min = 1s gap
    else await sleep(500);
  }
  console.log();
  return results;
}

function sleep(ms: number) { return new Promise(r=>setTimeout(r,ms)); }

function buildReasoning(c: ScoredCandidate, llm?: LlmResult): string {
  if (llm?.reasoning) return llm.reasoning;
  const r = c.raw;
  const top3 = (r.skills||[]).slice(0,3).map((s:any)=>s.name).join(', ');
  return `${r.profile?.years_of_experience}y exp ${r.profile?.current_title} with ${top3}; skill ${c.breakdown.skillMatch.toFixed(0)}/100, career ${c.breakdown.careerFit.toFixed(0)}/100.`;
}

function writeCsv(rows: {candidate_id:string;rank:number;score:number;reasoning:string}[]) {
  const lines = ['candidate_id,rank,score,reasoning'];
  for (const r of rows) {
    const safe = r.reasoning.replace(/"/g,"'").replace(/[\r\n,]/g,' ').slice(0,200);
    lines.push(`${r.candidate_id},${r.rank},${r.score.toFixed(4)},"${safe}"`);
  }
  fs.writeFileSync(outFile, lines.join('\n')+'\n','utf-8');
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Redrob Candidate Ranker\n');
  console.log(`  Provider:   ${noLlm ? 'NONE (pure deterministic)' : `${provider}${fallback!=='none'?` → ${fallback} (fallback)`:''}`}`);
  console.log(`  Output:     ${outFile}`);
  console.log(`  Top N:      ${TOP_N}\n`);

  if (!noLlm) {
    // Give early feedback on which providers are configured
    if (provider==='groq'   && !GROQ_KEY)   console.warn('  ⚠️  GROQ_API_KEY not set — will try fallback');
    if (provider==='gemini' && !GEMINI_KEY) console.warn('  ⚠️  GEMINI_API_KEY not set — will try fallback');
    if (provider==='ollama') console.log(`  Ollama URL: ${OLLAMA_URL} | Model: ${OLLAMA_MODEL}`);
    if (fallback==='gemini' && !GEMINI_KEY) console.warn('  ⚠️  GEMINI_API_KEY not set (fallback will fail too)');
  }

  console.log('\n🔌 Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('✅ Connected\n');

  const Schema = new mongoose.Schema({},{strict:false,timestamps:true});
  const Model  = mongoose.models.Candidate ?? mongoose.model('Candidate',Schema,'candidates');

  // 1. Score all candidates deterministically
  console.log('⚙️  Scoring candidates...');
  const t0 = Date.now();
  const BATCH = 500;
  const total = await Model.countDocuments();
  const scored: ScoredCandidate[] = [];
  let hp=0, dq=0;

  for (let skip=0; skip<total; skip+=BATCH) {
    const batch = await Model.find({},null,{lean:true}).skip(skip).limit(BATCH).exec();
    for (const c of batch) {
      const r = scoreCandidate(c as any);
      scored.push(r);
      if (r.isHoneypot) hp++; else if (r.disqualificationReason) dq++;
    }
    process.stdout.write(`\r  Scored: ${Math.min(skip+BATCH,total).toLocaleString()}/${total.toLocaleString()} | Honeypots: ${hp} | Disqualified: ${dq}`);
  }
  console.log(`\n  ⏱️  Done in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // 2. Sort eligible candidates
  const eligible = scored
    .filter(c=>!c.isHoneypot&&!c.disqualificationReason)
    .sort((a,b)=>{
      const d=b.breakdown.total-a.breakdown.total;
      return Math.abs(d)>0.001 ? d : a.candidate_id.localeCompare(b.candidate_id);
    });
  console.log(`📊 Eligible: ${eligible.length}/${total} (${hp} honeypots, ${dq} disqualified)\n`);

  // 3. LLM re-rank top candidates
  let llmMap = new Map<string,LlmResult>();
  if (!noLlm) {
    const topForLlm = eligible.slice(0, LLM_TOP);
    console.log(`🤖 LLM re-ranking top ${topForLlm.length} candidates (batch size=${LLM_BATCH})...`);
    llmMap = await llmRerank(topForLlm);
    console.log(`  ✅ Got LLM scores for ${llmMap.size} candidates\n`);
  }

  // 4. Blend scores and finalize top 100
  const finalRows = eligible
    .slice(0, LLM_TOP)
    .map(c => {
      const llm = llmMap.get(c.candidate_id);
      const score = llm
        ? c.breakdown.total*0.6 + llm.llmScore*0.4
        : c.breakdown.total;
      return { candidate_id:c.candidate_id, score:Math.round(score*10000)/10000, reasoning:buildReasoning(c,llm) };
    })
    .sort((a,b)=>{
      const d=b.score-a.score;
      return Math.abs(d)>0.0001 ? d : a.candidate_id.localeCompare(b.candidate_id);
    })
    .slice(0,TOP_N)
    .map((c,i)=>({...c, rank:i+1}));

  // Enforce non-increasing scores (validator requirement)
  for (let i=1; i<finalRows.length; i++) {
    if (finalRows[i].score > finalRows[i-1].score) {
      finalRows[i].score = Math.round((finalRows[i-1].score - 0.0001)*10000)/10000;
    }
  }

  // 5. Write CSV
  writeCsv(finalRows);
  console.log(`✅ Submission written → ${path.resolve(outFile)}`);
  console.log(`   Rows: ${finalRows.length}`);
  console.log(`   Score range: ${finalRows[finalRows.length-1]?.score.toFixed(4)} – ${finalRows[0]?.score.toFixed(4)}`);
  console.log(`\n🏆 Top 5:`);
  finalRows.slice(0,5).forEach(c=>console.log(`   #${c.rank} ${c.candidate_id} — ${c.score.toFixed(2)}`));
  console.log(`\n⏱️  Total: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log('\n👉 Validate: python3 validate_submission.py '+path.resolve(outFile));

  await mongoose.disconnect();
}

main().catch(err=>{
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});
