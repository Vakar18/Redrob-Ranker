#!/usr/bin/env node
/**
 * scripts/ingest-candidates.js
 *
 * Loads candidates.jsonl.gz (or candidates.jsonl / sample_candidates.json)
 * into MongoDB. Runs with plain `node` — no TypeScript compilation needed.
 *
 * Usage:
 *   MONGODB_URI=mongodb://localhost:27017/redrob_ranker \
 *     node scripts/ingest-candidates.js --file ./candidates.jsonl.gz
 *
 *   node scripts/ingest-candidates.js \
 *     --file ./sample_candidates.json --format json
 */

'use strict';

const fs       = require('fs');
const readline = require('readline');
const zlib     = require('zlib');
const path     = require('path');
const mongoose = require('mongoose');

// ── CLI args ─────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const fileArg  = getArg('--file')   ?? './candidates.jsonl.gz';
const format   = getArg('--format') ?? (fileArg.endsWith('.json') ? 'json' : 'jsonl');
const batchSz  = parseInt(getArg('--batch') ?? '500', 10);
const mongoUri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/redrob_ranker';

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

// ── Minimal Mongoose model ────────────────────────────────────────
const schema = new mongoose.Schema({}, { strict: false, timestamps: true, versionKey: false });
// Avoid model re-registration if this module is ever required twice
const Candidate = mongoose.models?.Candidate ?? mongoose.model('Candidate', schema, 'candidates');

// ── Bulk upsert helper ────────────────────────────────────────────
async function upsertBatch(batch) {
  if (batch.length === 0) return { inserted: 0, updated: 0 };
  const ops = batch.map(c => ({
    updateOne: {
      filter: { candidate_id: c.candidate_id },
      update:  { $set: c },
      upsert:  true,
    },
  }));
  const result = await Candidate.bulkWrite(ops, { ordered: false });
  return { inserted: result.upsertedCount, updated: result.modifiedCount };
}

// ── JSONL / JSONL.GZ ingestion ────────────────────────────────────
async function ingestJsonl(filePath) {
  const absPath = path.resolve(filePath);
  const isGzip  = absPath.endsWith('.gz');
  console.log(`📂  Reading: ${absPath} (${isGzip ? 'gzipped JSONL' : 'JSONL'})`);

  const raw    = fs.createReadStream(absPath);
  const stream = isGzip ? raw.pipe(zlib.createGunzip()) : raw;
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let batch = [], totalIns = 0, totalUpd = 0, lines = 0, errors = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      batch.push(JSON.parse(trimmed));
      lines++;
      if (batch.length >= batchSz) {
        const r = await upsertBatch(batch);
        totalIns += r.inserted; totalUpd += r.updated;
        batch = [];
        process.stdout.write(
          `\r  ✅ Lines: ${lines.toLocaleString()} | Inserted: ${totalIns} | Updated: ${totalUpd} | Errors: ${errors}  `
        );
      }
    } catch { errors++; }
  }

  if (batch.length > 0) {
    const r = await upsertBatch(batch);
    totalIns += r.inserted; totalUpd += r.updated;
  }

  console.log(`\n\n🎉 Done!  Lines: ${lines} | Inserted: ${totalIns} | Updated: ${totalUpd} | Errors: ${errors}`);
}

// ── Pretty-printed JSON array ingestion (sample_candidates.json) ──
async function ingestJson(filePath) {
  const absPath = path.resolve(filePath);
  console.log(`📂  Reading JSON: ${absPath}`);
  const raw  = fs.readFileSync(absPath, 'utf-8');
  const data = JSON.parse(raw);
  const arr  = Array.isArray(data) ? data : [data];
  console.log(`📦  ${arr.length} candidates found`);

  let totalIns = 0, totalUpd = 0;
  for (let i = 0; i < arr.length; i += batchSz) {
    const r = await upsertBatch(arr.slice(i, i + batchSz));
    totalIns += r.inserted; totalUpd += r.updated;
    process.stdout.write(`\r  ✅ ${Math.min(i + batchSz, arr.length)}/${arr.length}`);
  }
  console.log(`\n\n🎉 Done!  Inserted: ${totalIns} | Updated: ${totalUpd}`);
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('🔌 Connecting to MongoDB:', mongoUri);
  await mongoose.connect(mongoUri);
  console.log('✅ Connected\n');

  // Ensure indexes exist
  await Candidate.collection.createIndex({ candidate_id: 1 }, { unique: true }).catch(() => {});
  await Candidate.collection.createIndex({ computed_total_score: -1 }).catch(() => {});

  const t0 = Date.now();
  if (format === 'json') {
    await ingestJson(fileArg);
  } else {
    await ingestJsonl(fileArg);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`⏱️  Time: ${elapsed}s`);
  await mongoose.disconnect();
  console.log('👋 Disconnected.');
}

main().catch(err => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});