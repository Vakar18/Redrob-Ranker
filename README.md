# Redrob Intelligent Candidate Ranker

> **Redrob Hackathon — Intelligent Candidate Discovery & Ranking Challenge**
> Built with NestJS · MongoDB · BullMQ · Claude AI

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client / CLI                             │
│  POST /api/v1/ranking/start  ·  ts-node scripts/generate-...   │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                    NestJS API (port 3000)                       │
│  RankingController → RankingService → BullMQ Queue             │
└────────┬───────────────────────────────────────┬───────────────┘
         │ enqueue jobs                          │ persist results
┌────────▼────────────┐             ┌────────────▼───────────────┐
│   Redis (BullMQ)    │             │       MongoDB              │
│   ranking queue     │             │   candidates collection    │
│   3–5 workers       │             │   ~100K documents          │
└────────┬────────────┘             └────────────────────────────┘
         │ process
┌────────▼────────────────────────────────────────────────────────┐
│                   RankingProcessor (BullMQ Worker)              │
│                                                                 │
│  1. DeterministicScorer                                         │
│     ├── Skill Match     (35%) — hard/soft skill alignment       │
│     ├── Career Fit      (30%) — trajectory, product vs services │
│     ├── Behavioral      (20%) — platform engagement signals     │
│     └── Availability    (15%) — notice period, location, OTW    │
│                                                                 │
│  2. LlmReranker (Claude Sonnet 4.6)                             │
│     └── Semantic re-scoring + reasoning generation              │
│         for top 300 candidates                                  │
│                                                                 │
│  3. Blend: 60% deterministic + 40% LLM                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Scoring Design Philosophy

The scoring engine is built around a careful reading of **what the JD actually means**, not just what it says.

### Why Not Pure Keyword Matching?

The JD explicitly warns against this. A candidate listing "Pinecone" in their skills section without production context is less valuable than a candidate whose career description mentions "deployed vector search at scale" without naming the tool.

### Four Scoring Dimensions

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| **Skill Match** | 35% | Hard skills (embeddings, vector DBs, Python, eval frameworks) + soft skills (NLP/IR, LTR, fine-tuning) + Redrob assessment scores |
| **Career Fit** | 30% | YoE alignment (5–9y sweet spot), product company ratio, production deployment evidence, tenure length, education tier, GitHub activity |
| **Behavioral** | 20% | Profile completeness, recency of activity, recruiter response rate, interview completion, platform engagement |
| **Availability** | 15% | Open-to-work flag, notice period (sub-30d preferred), location fit (Noida/Pune/India), work mode preference |

### Honeypot Detection

The dataset contains ~80 honeypots with subtly impossible profiles. We detect them by:
- Too many `expert`-level skills (>20) — keyword stuffers
- Title/skills mismatch (e.g., Marketing Manager with AI skills)
- Seniority claims without any production evidence in descriptions

### Hard Disqualifiers (JD-Driven)

- Entire career at consulting firms (TCS, Infosys, Wipro, Accenture, etc.)
- Primary expertise in CV/Speech/Robotics with negligible NLP/IR
- Under 4 years total experience

### Behavioral Penalty System

A "perfect-on-paper" candidate inactive for 6+ months is down-weighted heavily (as the JD explicitly notes). Last-active recency is a 20-point dimension in the behavioral score.

---

## Quick Start (100% Free — No Paid API Needed)

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- One free LLM key (see options below — all are genuinely free, no credit card)

---

### Free LLM Provider Setup (pick one or all)

#### Option A — Groq ⚡ (Recommended: fastest, free, no credit card)
1. Go to **https://console.groq.com** → Sign up (free)
2. Create an API key
3. Add to `.env`: `GROQ_API_KEY=gsk_...`
4. Free limits: 30 req/min, 14,400 req/day on llama3-70b — more than enough

#### Option B — Google Gemini 🔵 (Free tier: 1500 req/day)
1. Go to **https://aistudio.google.com/app/apikey** → Sign in with Google
2. Click "Create API Key" (free, no billing setup required)
3. Add to `.env`: `GEMINI_API_KEY=AIza...`
4. Free limits: 60 req/min, 1500 req/day on gemini-1.5-flash

#### Option C — Ollama 🦙 (Fully local — zero cost, zero internet during ranking)
```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model (one-time download ~4GB)
ollama pull llama3.1     # 8B, fast, good quality
# or
ollama pull mistral      # 7B, very fast

# Ollama runs at http://localhost:11434 automatically
```
Set in `.env`: `OLLAMA_BASE_URL=http://localhost:11434`, `OLLAMA_MODEL=llama3.1`

#### Option D — No LLM (pure deterministic, zero dependencies)
Works great too — the deterministic scorer is already highly tuned to the JD.

---

### 1. Install and configure

```bash
git clone <your-repo>
cd redrob-ranker
npm install
cp .env.example .env

# Edit .env — set at least one of:
#   GROQ_API_KEY=gsk_...
#   GEMINI_API_KEY=AIza...
#   OLLAMA_MODEL=llama3.1   (if running Ollama locally)
```

### 2. Start infrastructure

```bash
docker compose up -d mongo redis
# Optional: Bull Board dashboard at http://localhost:3001
docker compose up -d bull-board
```

### 3. Ingest candidates

```bash
# Full 100K dataset
MONGODB_URI=mongodb://localhost:27017/redrob_ranker \
  ts-node scripts/ingest-candidates.ts --file ./candidates.jsonl.gz

# Sample 50 candidates (quick test)
MONGODB_URI=mongodb://localhost:27017/redrob_ranker \
  ts-node scripts/ingest-candidates.ts \
  --file ./sample_candidates.json --format json
```

### 4. Generate submission

```bash
# Using Groq (recommended — free + fast)
MONGODB_URI=mongodb://localhost:27017/redrob_ranker \
GROQ_API_KEY=gsk_... \
  ts-node scripts/generate-submission.ts --provider groq --out ./team_name.csv

# Using Gemini (free, 1500 req/day)
GEMINI_API_KEY=AIza... \
  ts-node scripts/generate-submission.ts --provider gemini --out ./team_name.csv

# Using Ollama (fully local, no internet needed)
  ts-node scripts/generate-submission.ts --provider ollama --out ./team_name.csv

# Groq primary + Gemini fallback (most resilient)
GROQ_API_KEY=gsk_... GEMINI_API_KEY=AIza... \
  ts-node scripts/generate-submission.ts --provider groq --fallback gemini --out ./team_name.csv

# No LLM — pure deterministic (zero dependencies)
  ts-node scripts/generate-submission.ts --no-llm --out ./team_name.csv
```

### 5. Validate

```bash
python3 validate_submission.py ./team_name.csv
# Expected output: "Submission is valid."
```

---

## API Server (Optional)

Start the NestJS server for the HTTP API + queue management:

```bash
npm run start:dev
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | Health check |
| `POST` | `/api/v1/ranking/start` | Start ranking pipeline |
| `GET` | `/api/v1/ranking/status` | Pipeline progress |
| `GET` | `/api/v1/ranking/queue` | BullMQ queue metrics |
| `POST` | `/api/v1/ranking/retry-failed` | Retry failed jobs |
| `GET` | `/api/v1/candidates/top?n=100` | Top-N ranked candidates |
| `GET` | `/api/v1/candidates/count` | Ingestion stats |
| `GET` | `/api/docs` | Swagger UI |

### Start ranking via API

```bash
curl -X POST http://localhost:3000/api/v1/ranking/start \
  -H "Content-Type: application/json" \
  -d '{
    "batchSize": 50,
    "topN": 100,
    "enableLlmRerank": true,
    "llmBatchSize": 10,
    "outputPath": "./submission.csv"
  }'
```

---

## Docker Full Stack

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up --build
```

This starts: NestJS app · MongoDB · Redis · Bull Board dashboard

---

## Project Structure

```
redrob-ranker/
├── src/
│   ├── app.module.ts                    # Root module
│   ├── main.ts                          # Bootstrap
│   ├── config/
│   │   └── app.config.ts               # All env-based config
│   ├── types/
│   │   └── candidate.types.ts          # TypeScript domain types
│   └── modules/
│       ├── candidates/
│       │   ├── schemas/candidate.schema.ts
│       │   ├── services/candidates.service.ts
│       │   └── controllers/candidates.controller.ts
│       ├── ranking/
│       │   ├── constants/queue.constants.ts
│       │   ├── dto/start-ranking.dto.ts
│       │   ├── strategies/
│       │   │   ├── deterministic-scorer.ts  ← Core scoring engine
│       │   │   └── llm-reranker.ts          ← Claude integration
│       │   ├── processors/ranking.processor.ts  ← BullMQ worker
│       │   ├── services/ranking.service.ts
│       │   └── controllers/ranking.controller.ts
│       └── health/health.module.ts
├── scripts/
│   ├── ingest-candidates.ts            # Load JSONL → MongoDB
│   ├── generate-submission.ts          # End-to-end ranking → CSV
│   └── mongo-init.js                   # MongoDB index setup
├── test/
│   └── deterministic-scorer.spec.ts
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

---

## BullMQ Scaling Architecture

For 100K candidates, the pipeline runs as follows:

```
100,000 candidates
       ÷ 50 per batch
= 2,000 SCORE_BATCH jobs enqueued simultaneously

Workers (configurable, default 5 concurrent):
  Worker 1: batches 0, 5, 10, 15 ...
  Worker 2: batches 1, 6, 11, 16 ...
  Worker 3: batches 2, 7, 12, 17 ...
  Worker 4: batches 3, 8, 13, 18 ...
  Worker 5: batches 4, 9, 14, 19 ...

After all complete → FINALIZE_RANKING job → submission.csv
```

BullMQ guarantees:
- **At-least-once delivery** with configurable retries
- **Automatic retry with exponential backoff** on LLM API failures
- **Job progress tracking** per batch (visible in Bull Board)
- **Delayed jobs** for the finalization step
- **Priority queue** (finalization has priority=1, lower than batch jobs)

---

## Key Engineering Decisions

### Why MongoDB?

- Flexible schema for heterogeneous candidate data
- Efficient aggregation for bulk upserts (`bulkWrite`)
- Index on `computed_total_score DESC` makes top-N retrieval O(log n)
- Native streaming support for large datasets

### Why BullMQ over direct processing?

- Resilience: crashed workers automatically retry failed jobs
- Horizontal scaling: add more workers by increasing `concurrency`
- Visibility: Bull Board shows exactly which candidates failed and why
- Rate limiting: natural backpressure prevents overwhelming the LLM API

### Free LLM Provider Comparison

| Provider | Cost | Speed | Rate Limit | Quality | Best For |
|----------|------|-------|------------|---------|----------|
| **Groq** | Free | ⚡ Very fast | 14,400 req/day | llama3-70b → Excellent | Default choice |
| **Gemini 1.5 Flash** | Free | Fast | 1,500 req/day | Excellent | Groq fallback |
| **Ollama (llama3.1)** | Free | Medium | Unlimited | Very Good | Offline / no internet |
| **Deterministic only** | Free | Instant | Unlimited | Good | Hackathon constraint mode |

All four produce valid, submission-ready CSVs. The LLM providers add semantic understanding on top of the deterministic scoring foundation.

### Why 60/40 Deterministic/LLM blend?

- Pure LLM is too expensive for 100K candidates ($$$)
- Pure deterministic misses semantic nuance (e.g., candidate says "recommendation system" not "vector search")
- Blend: deterministic filters/scores all 100K cheaply; LLM semantically validates the top 300

### Compute constraint compliance (5min/16GB/CPU-only)

The `generate-submission.ts` script runs completely offline:
- No network calls during scoring
- Pure JS arithmetic — no GPU needed
- Streams MongoDB in 500-document batches → ~2GB peak memory for 100K records
- Full scoring of 100K candidates: ~60–90 seconds on a modern CPU
# Redrob-Ranker
