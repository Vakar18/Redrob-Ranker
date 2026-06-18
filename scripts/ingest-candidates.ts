#!/usr/bin/env ts-node
/**
 * scripts/ingest-candidates.ts
 *
 * Loads candidates.jsonl.gz (or candidates.jsonl) into MongoDB.
 * Handles chunked upserts for memory efficiency on 100K records.
 *
 * Usage:
 *   ts-node scripts/ingest-candidates.ts --file ./candidates.jsonl.gz
 *   ts-node scripts/ingest-candidates.ts --file ./sample_candidates.json --format json
 */

import * as fs from 'fs';
import * as readline from 'readline';
import * as zlib from 'zlib';
import * as path from 'path';
import mongoose from 'mongoose';

// ── Parse CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const fileArg = args[indexOf('--file', args)] ?? './candidates.jsonl.gz';
const formatArg = (args[indexOf('--format', args)] ?? 'jsonl') as 'jsonl' | 'json';
const batchArg = parseInt(args[indexOf('--batch', args)] ?? '500', 10);
const mongoUri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/redrob_ranker';

function indexOf(flag: string, arr: string[]): number {
  const i = arr.indexOf(flag);
  return i !== -1 ? i + 1 : -1;
}

// ── MongoDB setup ───────────────────────────────────────────────
const CandidateSchema = new mongoose.Schema({
  candidate_id: { type: String, required: true, unique: true, index: true },
  profile: mongoose.Schema.Types.Mixed,
  career_history: [mongoose.Schema.Types.Mixed],
  education: [mongoose.Schema.Types.Mixed],
  skills: [mongoose.Schema.Types.Mixed],
  certifications: [mongoose.Schema.Types.Mixed],
  languages: [mongoose.Schema.Types.Mixed],
  redrob_signals: mongoose.Schema.Types.Mixed,
  computed_skill_score: { type: Number, default: null },
  computed_career_score: { type: Number, default: null },
  computed_behavioral_score: { type: Number, default: null },
  computed_availability_score: { type: Number, default: null },
  computed_total_score: { type: Number, default: null },
  is_honeypot: { type: Boolean, default: false },
  disqualification_reason: { type: String, default: null },
  reasoning: { type: String, default: null },
}, { timestamps: true, versionKey: false });

const CandidateModel = mongoose.model('Candidate', CandidateSchema, 'candidates');

// ── Core ingestion logic ─────────────────────────────────────────

async function upsertBatch(batch: any[]): Promise<{ inserted: number; updated: number }> {
  const ops = batch.map((c) => ({
    updateOne: {
      filter: { candidate_id: c.candidate_id },
      update: { $set: c },
      upsert: true,
    },
  }));
  const result = await CandidateModel.bulkWrite(ops, { ordered: false });
  return { inserted: result.upsertedCount, updated: result.modifiedCount };
}

async function ingestJsonl(filePath: string): Promise<void> {
  const absPath = path.resolve(filePath);
  const isGzip = absPath.endsWith('.gz');

  console.log(`📂 Reading: ${absPath} (${isGzip ? 'gzipped JSONL' : 'plain JSONL'})`);

  const rawStream = fs.createReadStream(absPath);
  const stream = isGzip ? rawStream.pipe(zlib.createGunzip()) : rawStream;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let batch: any[] = [];
  let totalInserted = 0;
  let totalUpdated = 0;
  let lineCount = 0;
  let errorCount = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const candidate = JSON.parse(trimmed);
      batch.push(candidate);
      lineCount++;

      if (batch.length >= batchArg) {
        const result = await upsertBatch(batch);
        totalInserted += result.inserted;
        totalUpdated += result.updated;
        batch = [];
        process.stdout.write(
          `\r✅ Processed: ${lineCount.toLocaleString()} | Inserted: ${totalInserted} | Updated: ${totalUpdated} | Errors: ${errorCount}`,
        );
      }
    } catch (e) {
      errorCount++;
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const result = await upsertBatch(batch);
    totalInserted += result.inserted;
    totalUpdated += result.updated;
  }

  console.log(`\n\n🎉 Ingestion complete!`);
  console.log(`   Total lines:  ${lineCount.toLocaleString()}`);
  console.log(`   Inserted:     ${totalInserted.toLocaleString()}`);
  console.log(`   Updated:      ${totalUpdated.toLocaleString()}`);
  console.log(`   Errors:       ${errorCount}`);
}

async function ingestJson(filePath: string): Promise<void> {
  const absPath = path.resolve(filePath);
  console.log(`📂 Reading JSON: ${absPath}`);

  const content = fs.readFileSync(absPath, 'utf-8');
  const data = JSON.parse(content);
  const candidates = Array.isArray(data) ? data : [data];

  console.log(`📦 Found ${candidates.length} candidates in JSON file`);

  let totalInserted = 0;
  let totalUpdated = 0;

  for (let i = 0; i < candidates.length; i += batchArg) {
    const batch = candidates.slice(i, i + batchArg);
    const result = await upsertBatch(batch);
    totalInserted += result.inserted;
    totalUpdated += result.updated;
    process.stdout.write(`\r✅ ${i + batch.length}/${candidates.length}`);
  }

  console.log(`\n\n🎉 Ingestion complete! Inserted: ${totalInserted}, Updated: ${totalUpdated}`);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('🔌 Connecting to MongoDB:', mongoUri);
  await mongoose.connect(mongoUri);
  console.log('✅ Connected\n');

  // Ensure indexes
  await CandidateModel.createIndexes();

  const startTime = Date.now();

  if (formatArg === 'json') {
    await ingestJson(fileArg);
  } else {
    await ingestJsonl(fileArg);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`⏱️  Time: ${elapsed}s`);

  await mongoose.disconnect();
  console.log('👋 Disconnected from MongoDB');
}

main().catch((err) => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
