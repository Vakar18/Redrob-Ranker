import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { rankingConfig } from '@config/app.config';
import { DeterministicScorer } from '@modules/ranking/strategies/deterministic-scorer';
import { describe, beforeEach, it } from 'node:test';
// import { DeterministicScorer } from '../../src/modules/ranking/strategies/deterministic-scorer';
// import { rankingConfig } from '../../src/config/app.config';

// ── Test fixtures ────────────────────────────────────────────────

const IDEAL_CANDIDATE = {
  candidate_id: 'CAND_TEST001',
  profile: {
    anonymized_name: 'Test User',
    headline: 'Senior ML Engineer - Embeddings & Vector Search',
    summary: 'Built production retrieval and ranking systems. Expert in embeddings, Pinecone, FAISS, hybrid search at scale.',
    location: 'Noida',
    country: 'India',
    years_of_experience: 7,
    current_title: 'Senior ML Engineer',
    current_company: 'Product Co',
    current_company_size: '201-500',
    current_industry: 'Technology',
  },
  career_history: [
    {
      company: 'Product Co',
      title: 'Senior ML Engineer',
      start_date: '2021-01-01',
      end_date: null,
      duration_months: 36,
      is_current: true,
      industry: 'Technology',
      company_size: '201-500',
      description: 'Built production embedding-based retrieval system serving 1M+ users. Deployed FAISS index with hybrid search, improving NDCG by 23%. Extensive A/B testing.',
    },
    {
      company: 'AI Startup',
      title: 'ML Engineer',
      start_date: '2018-01-01',
      end_date: '2021-01-01',
      duration_months: 36,
      is_current: false,
      industry: 'AI',
      company_size: '51-200',
      description: 'Shipped recommendation system with vector search using Pinecone and sentence-transformers. Python codebase deployed at scale.',
    },
  ],
  education: [
    { institution: 'IIT Delhi', degree: 'B.Tech', field_of_study: 'CS', start_year: 2014, end_year: 2018, grade: '8.5', tier: 'tier_1' },
  ],
  skills: [
    { name: 'Python', proficiency: 'expert', endorsements: 50, duration_months: 84 },
    { name: 'Embeddings', proficiency: 'expert', endorsements: 40, duration_months: 48 },
    { name: 'Pinecone', proficiency: 'advanced', endorsements: 30, duration_months: 36 },
    { name: 'FAISS', proficiency: 'advanced', endorsements: 25, duration_months: 36 },
    { name: 'NLP', proficiency: 'advanced', endorsements: 35, duration_months: 60 },
    { name: 'LoRA', proficiency: 'intermediate', endorsements: 10, duration_months: 12 },
  ],
  redrob_signals: {
    profile_completeness_score: 95,
    signup_date: '2024-01-01',
    last_active_date: new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0],
    open_to_work_flag: true,
    profile_views_received_30d: 45,
    applications_submitted_30d: 3,
    recruiter_response_rate: 0.85,
    avg_response_time_hours: 4,
    skill_assessment_scores: { Python: 92, 'Machine Learning': 88 },
    connection_count: 350,
    endorsements_received: 120,
    notice_period_days: 15,
    expected_salary_range_inr_lpa: { min: 30, max: 45 },
    preferred_work_mode: 'hybrid',
    willing_to_relocate: true,
    github_activity_score: 72,
    search_appearance_30d: 60,
    saved_by_recruiters_30d: 8,
    interview_completion_rate: 0.9,
    offer_acceptance_rate: 0.7,
    verified_email: true,
    verified_phone: true,
    linkedin_connected: true,
  },
};

const HONEYPOT_CANDIDATE = {
  ...IDEAL_CANDIDATE,
  candidate_id: 'CAND_TEST002',
  profile: {
    ...IDEAL_CANDIDATE.profile,
    current_title: 'Marketing Manager',
  },
  skills: Array.from({ length: 25 }, (_, i) => ({
    name: `ExpertSkill${i}`,
    proficiency: 'expert' as const,
    endorsements: 99,
    duration_months: 60,
  })),
};

const CONSULTING_ONLY = {
  ...IDEAL_CANDIDATE,
  candidate_id: 'CAND_TEST003',
  career_history: [
    { ...IDEAL_CANDIDATE.career_history[0], company: 'Infosys', industry: 'IT Services' },
    { ...IDEAL_CANDIDATE.career_history[1], company: 'Wipro', industry: 'IT Services' },
  ],
};

const INACTIVE_CANDIDATE = {
  ...IDEAL_CANDIDATE,
  candidate_id: 'CAND_TEST004',
  redrob_signals: {
    ...IDEAL_CANDIDATE.redrob_signals,
    last_active_date: '2024-06-01', // >180 days ago
    open_to_work_flag: false,
    recruiter_response_rate: 0.05,
    notice_period_days: 90,
  },
};

// ── Tests ────────────────────────────────────────────────────────

describe('DeterministicScorer', () => {
  let scorer: DeterministicScorer;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ load: [rankingConfig] })],
      providers: [DeterministicScorer],
    }).compile();

    scorer = module.get<DeterministicScorer>(DeterministicScorer);
  });

  describe('Honeypot detection', () => {
    it('should flag candidate with 25 expert skills as honeypot', () => {
      const result = scorer.score(HONEYPOT_CANDIDATE as any);
      expect(result.isHoneypot).toBe(true);
      expect(result.breakdown.total).toBe(0);
    });
  });

  describe('Disqualifiers', () => {
    it('should disqualify consulting-only candidate', () => {
      const result = scorer.score(CONSULTING_ONLY as any);
      expect(result.disqualificationReason).toContain('consulting');
      expect(result.breakdown.total).toBe(0);
    });
  });

  describe('Ideal candidate scoring', () => {
    it('should give ideal candidate a high composite score (>70)', () => {
      const result = scorer.score(IDEAL_CANDIDATE as any);
      expect(result.isHoneypot).toBe(false);
      expect(result.disqualificationReason).toBeNull();
      expect(result.breakdown.total).toBeGreaterThan(70);
    });

    it('should give high skill match score for candidate with embeddings experience', () => {
      const result = scorer.score(IDEAL_CANDIDATE as any);
      expect(result.breakdown.skillMatch).toBeGreaterThan(60);
    });

    it('should give high career fit to product company engineer', () => {
      const result = scorer.score(IDEAL_CANDIDATE as any);
      expect(result.breakdown.careerFit).toBeGreaterThan(60);
    });
  });

  describe('Behavioral scoring', () => {
    it('should penalize inactive candidates significantly', () => {
      const activeResult = scorer.score(IDEAL_CANDIDATE as any);
      const inactiveResult = scorer.score(INACTIVE_CANDIDATE as any);
      expect(activeResult.breakdown.behavioral).toBeGreaterThan(
        inactiveResult.breakdown.behavioral + 15,
      );
    });

    it('should give high availability score to open-to-work candidate in Noida', () => {
      const result = scorer.score(IDEAL_CANDIDATE as any);
      expect(result.breakdown.availability).toBeGreaterThan(70);
    });
  });

  describe('Score ordering', () => {
    it('ideal candidate should outscore inactive candidate', () => {
      const ideal = scorer.score(IDEAL_CANDIDATE as any);
      const inactive = scorer.score(INACTIVE_CANDIDATE as any);
      expect(ideal.breakdown.total).toBeGreaterThan(inactive.breakdown.total);
    });
  });
});
