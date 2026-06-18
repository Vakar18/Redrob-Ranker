// scripts/mongo-init.js
// Runs on first container start to set up indexes

db = db.getSiblingDB('redrob_ranker');

db.createCollection('candidates');

db.candidates.createIndex({ candidate_id: 1 }, { unique: true });
db.candidates.createIndex({ computed_total_score: -1 });
db.candidates.createIndex({ 'profile.years_of_experience': 1 });
db.candidates.createIndex({ 'redrob_signals.open_to_work_flag': 1 });
db.candidates.createIndex({ 'redrob_signals.last_active_date': -1 });
db.candidates.createIndex({ is_honeypot: 1, computed_total_score: -1 });

print('MongoDB initialized: redrob_ranker collection and indexes created.');
