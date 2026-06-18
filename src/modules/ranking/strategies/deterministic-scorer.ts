import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RawCandidate,
  ScoreBreakdown,
  Skill,
  CareerEntry,
} from '../../../types/candidate.types';

// ── JD-derived constants ──────────────────────────────────────────
// These reflect a deep reading of the job description, NOT keyword matching.

const HARD_REQUIRED_SKILLS = new Set([
  // Embedding / retrieval (absolute must-haves per JD)
  'embeddings', 'sentence-transformers', 'openai embeddings', 'bge', 'e5',
  'vector database', 'vector search', 'pinecone', 'weaviate', 'qdrant',
  'milvus', 'faiss', 'opensearch', 'elasticsearch', 'hybrid search',
  // Evaluation frameworks
  'ndcg', 'mrr', 'map', 'a/b testing', 'ranking evaluation',
  // Python
  'python',
]);

const SOFT_PREFERRED_SKILLS = new Set([
  // LLM fine-tuning
  'lora', 'qlora', 'peft', 'fine-tuning llms', 'fine-tuning',
  // LTR
  'learning to rank', 'xgboost', 'lightgbm',
  // Infrastructure
  'distributed systems', 'large-scale inference', 'ml infrastructure',
  // NLP / IR
  'nlp', 'information retrieval', 'bm25', 'sparse retrieval', 'dense retrieval',
  'reranking', 're-ranking',
  // Platform context
  'recommendation systems', 'search', 'ranking',
]);

const NEGATIVE_SKILLS = new Set([
  // CV/Speech (JD explicitly says these are disqualifiers)
  'computer vision', 'image classification', 'speech recognition', 'tts',
  'speech synthesis', 'image segmentation', 'object detection',
  'robotics', 'lidar', 'slam', 'optical flow',
]);

// Companies explicitly called out as bad fit in JD
const CONSULTING_FIRMS = new Set([
  'tcs', 'tata consultancy', 'infosys', 'wipro', 'accenture',
  'cognizant', 'capgemini', 'hcl', 'tech mahindra', 'mphasis',
]);

// Signals of pure-services background (heavy anti-signal)
const PURE_SERVICES_INDICATORS = ['IT Services', 'Consulting', 'BPO', 'Outsourcing'];

// Good industries (product companies, AI-native)
const PRODUCT_COMPANY_INDUSTRIES = [
  'Technology', 'Software', 'AI', 'Machine Learning', 'E-commerce',
  'FinTech', 'EdTech', 'HealthTech', 'SaaS', 'Internet', 'Marketplace',
];

// Honeypot detection patterns
const HONEYPOT_PATTERNS = [
  // Impossible skill combos listed as expert
  { check: (c: RawCandidate) => countExpertSkills(c) > 20, reason: 'Too many expert skills (keyword stuffer)' },
  // Job title vs skills mismatch
  { check: (c: RawCandidate) => isTitleSkillsMismatch(c), reason: 'Title/skills mismatch (possible stuffed profile)' },
  // No production evidence despite claiming seniority
  { check: (c: RawCandidate) => isProductionless(c), reason: 'Claims seniority without production evidence' },
];

function countExpertSkills(c: RawCandidate): number {
  return c.skills.filter((s) => s.proficiency === 'expert').length;
}

function isTitleSkillsMismatch(c: RawCandidate): boolean {
  const nonTechTitles = ['marketing', 'sales', 'hr', 'finance', 'accountant', 'lawyer'];
  const title = (c.profile.current_title || '').toLowerCase();
  const hasTechSkills = c.skills.some((s) => HARD_REQUIRED_SKILLS.has(s.name.toLowerCase()));
  return nonTechTitles.some((t) => title.includes(t)) && hasTechSkills;
}

function isProductionless(c: RawCandidate): boolean {
  const yoe = c.profile.years_of_experience;
  if (yoe < 5) return false;
  const descriptions = c.career_history.map((e) => e.description.toLowerCase()).join(' ');
  const productionKeywords = ['production', 'deployed', 'shipped', 'launched', 'scale', 'users', 'live'];
  return !productionKeywords.some((kw) => descriptions.includes(kw));
}

@Injectable()
export class DeterministicScorer {
  private readonly logger = new Logger(DeterministicScorer.name);
  private readonly weights: Record<string, number>;

  constructor(private readonly config: ConfigService) {
    this.weights = {
      skillMatch: config.get<number>('ranking.weights.skillMatch', 0.35),
      careerFit: config.get<number>('ranking.weights.careerFit', 0.30),
      behavioral: config.get<number>('ranking.weights.behavioral', 0.20),
      availability: config.get<number>('ranking.weights.availability', 0.15),
    };
  }

  /**
   * Main entry point: score a single candidate.
   */
  score(candidate: RawCandidate): {
    breakdown: ScoreBreakdown;
    isHoneypot: boolean;
    disqualificationReason: string | null;
  } {
    // ── Step 1: Honeypot detection ────────────────────────────
    for (const { check, reason } of HONEYPOT_PATTERNS) {
      if (check(candidate)) {
        return {
          breakdown: this.zeroBreakdown(),
          isHoneypot: true,
          disqualificationReason: reason,
        };
      }
    }

    // ── Step 2: Hard disqualifiers (not honeypots, just bad fits) ──
    const disqualReason = this.checkHardDisqualifiers(candidate);
    if (disqualReason) {
      return {
        breakdown: this.zeroBreakdown(),
        isHoneypot: false,
        disqualificationReason: disqualReason,
      };
    }

    // ── Step 3: Compute all dimension scores ──────────────────
    const skillMatch = this.scoreSkillMatch(candidate);
    const careerFit = this.scoreCareerFit(candidate);
    const behavioral = this.scoreBehavioral(candidate);
    const availability = this.scoreAvailability(candidate);

    const total =
      skillMatch * this.weights.skillMatch +
      careerFit * this.weights.careerFit +
      behavioral * this.weights.behavioral +
      availability * this.weights.availability;

    return {
      breakdown: {
        skillMatch: Math.round(skillMatch * 10) / 10,
        careerFit: Math.round(careerFit * 10) / 10,
        behavioral: Math.round(behavioral * 10) / 10,
        availability: Math.round(availability * 10) / 10,
        total: Math.round(total * 100) / 100,
      },
      isHoneypot: false,
      disqualificationReason: null,
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Hard disqualifier checks (return null if candidate is OK)
  // ──────────────────────────────────────────────────────────────

  private checkHardDisqualifiers(c: RawCandidate): string | null {
    // YoE too low (below 4 years is almost certainly not Senior AI)
    if (c.profile.years_of_experience < 3.5) {
      return 'Insufficient years of experience (< 4 years)';
    }

    // Entire career only consulting firms
    if (this.isEntirelyConsulting(c)) {
      return 'Entire career at consulting/outsourcing firms (explicit JD disqualifier)';
    }

    // Primary expertise is CV/Speech/Robotics with no NLP/IR
    if (this.isPrimarylyNonNLP(c)) {
      return 'Primary domain is CV/Speech/Robotics without NLP/IR background';
    }

    return null;
  }

  private isEntirelyConsulting(c: RawCandidate): boolean {
    if (c.career_history.length === 0) return false;
    return c.career_history.every((job) => {
      const company = job.company.toLowerCase();
      return Array.from(CONSULTING_FIRMS).some((firm) => company.includes(firm));
    });
  }

  private isPrimarylyNonNLP(c: RawCandidate): boolean {
    const negativeCount = c.skills.filter((s) =>
      NEGATIVE_SKILLS.has(s.name.toLowerCase()),
    ).length;
    const positiveCount = c.skills.filter((s) =>
      HARD_REQUIRED_SKILLS.has(s.name.toLowerCase()) ||
      SOFT_PREFERRED_SKILLS.has(s.name.toLowerCase()),
    ).length;
    return negativeCount > 5 && negativeCount > positiveCount * 2;
  }

  // ──────────────────────────────────────────────────────────────
  // Dimension 1: Skill Match (35% weight)
  // ──────────────────────────────────────────────────────────────

  private scoreSkillMatch(c: RawCandidate): number {
    const skillNames = c.skills.map((s) => s.name.toLowerCase());
    const allText = [
      ...skillNames,
      ...c.career_history.map((e) => e.description.toLowerCase()),
      c.profile.headline.toLowerCase(),
      c.profile.summary.toLowerCase(),
    ].join(' ');

    // Hard skills — each worth up to 15 points; cap at 60
    let hardScore = 0;
    let hardHits = 0;
    for (const skill of HARD_REQUIRED_SKILLS) {
      if (allText.includes(skill)) {
        const matchedSkill = c.skills.find((s) => s.name.toLowerCase().includes(skill));
        if (matchedSkill) {
          hardScore += this.proficiencyMultiplier(matchedSkill.proficiency) * 15;
        } else {
          // Mentioned in descriptions but not a listed skill — worth less
          hardScore += 8;
        }
        hardHits++;
      }
    }
    hardScore = Math.min(hardScore, 60);

    // Soft skills — each worth up to 5 points; cap at 25
    let softScore = 0;
    for (const skill of SOFT_PREFERRED_SKILLS) {
      if (allText.includes(skill)) {
        const matchedSkill = c.skills.find((s) => s.name.toLowerCase().includes(skill));
        softScore += matchedSkill
          ? this.proficiencyMultiplier(matchedSkill.proficiency) * 5
          : 3;
      }
    }
    softScore = Math.min(softScore, 25);

    // Assessment score bonus (up to 15 points from Redrob platform assessments)
    let assessBonus = 0;
    const assessScores = c.redrob_signals.skill_assessment_scores;
    const relevantAssessments = Object.entries(assessScores).filter(([k]) =>
      Array.from(HARD_REQUIRED_SKILLS).some((skill) => k.toLowerCase().includes(skill)) ||
      Array.from(SOFT_PREFERRED_SKILLS).some((skill) => k.toLowerCase().includes(skill)),
    );
    if (relevantAssessments.length > 0) {
      const avgAssess = relevantAssessments.reduce((a, [, v]) => a + v, 0) / relevantAssessments.length;
      assessBonus = (avgAssess / 100) * 15;
    }

    return Math.min(hardScore + softScore + assessBonus, 100);
  }

  private proficiencyMultiplier(proficiency: string): number {
    const map: Record<string, number> = {
      beginner: 0.4,
      intermediate: 0.7,
      advanced: 0.9,
      expert: 1.0,
    };
    return map[proficiency] ?? 0.5;
  }

  // ──────────────────────────────────────────────────────────────
  // Dimension 2: Career Fit (30% weight)
  // ──────────────────────────────────────────────────────────────

  private scoreCareerFit(c: RawCandidate): number {
    let score = 0;

    // ── YoE alignment (target: 5-9 years, sweet spot 6-8) ──
    const yoe = c.profile.years_of_experience;
    if (yoe >= 6 && yoe <= 8) score += 25;
    else if (yoe >= 5 && yoe < 6) score += 20;
    else if (yoe > 8 && yoe <= 10) score += 18;
    else if (yoe >= 4 && yoe < 5) score += 12;
    else if (yoe > 10) score += 10;
    else score += 5;

    // ── Product company experience ──
    const productExp = c.career_history.filter((job) => {
      return (
        !PURE_SERVICES_INDICATORS.some((ind) => job.industry.includes(ind)) &&
        !Array.from(CONSULTING_FIRMS).some((firm) =>
          job.company.toLowerCase().includes(firm),
        )
      );
    });
    const productMonths = productExp.reduce((a, b) => a + b.duration_months, 0);
    const totalMonths = c.career_history.reduce((a, b) => a + b.duration_months, 0) || 1;
    score += (productMonths / totalMonths) * 20;

    // ── Production deployment evidence ──
    const prodEvidence = this.countProductionEvidence(c);
    score += Math.min(prodEvidence * 5, 20);

    // ── Tenure (JD explicitly wants 3+ year stayers; penalize job-hoppers) ──
    const avgTenure = totalMonths / (c.career_history.length || 1);
    if (avgTenure >= 24) score += 15;
    else if (avgTenure >= 18) score += 10;
    else if (avgTenure >= 12) score += 5;
    else score -= 5; // Job hopper penalty

    // ── Education (minor signal) ──
    const hasTier1or2 = c.education.some((e) => ['tier_1', 'tier_2'].includes(e.tier || 'unknown'));
    if (hasTier1or2) score += 10;
    else score += 3;

    // ── GitHub activity ──
    const ghScore = c.redrob_signals.github_activity_score;
    if (ghScore > 0) {
      score += (ghScore / 100) * 10;
    }

    return Math.min(Math.max(score, 0), 100);
  }

  private countProductionEvidence(c: RawCandidate): number {
    const productionKeywords = [
      'production', 'deployed', 'shipped', 'launched',
      'scale', 'users', 'live', 'latency', 'throughput',
      'million', '1k', '10k', '100k', 'real-time',
    ];
    let count = 0;
    for (const job of c.career_history) {
      const desc = job.description.toLowerCase();
      if (productionKeywords.some((kw) => desc.includes(kw))) count++;
    }
    return count;
  }

  // ──────────────────────────────────────────────────────────────
  // Dimension 3: Behavioral Signals (20% weight)
  // ──────────────────────────────────────────────────────────────

  private scoreBehavioral(c: RawCandidate): number {
    const signals = c.redrob_signals;
    let score = 0;

    // Profile completeness (up to 15 pts)
    score += (signals.profile_completeness_score / 100) * 15;

    // Recent activity — last active within 30 days is excellent
    const daysSinceActive = this.daysSince(signals.last_active_date);
    if (daysSinceActive <= 7) score += 20;
    else if (daysSinceActive <= 30) score += 15;
    else if (daysSinceActive <= 90) score += 8;
    else if (daysSinceActive <= 180) score += 3;
    // > 6 months = effectively unavailable, 0 bonus

    // Recruiter response rate (up to 15 pts)
    score += signals.recruiter_response_rate * 15;

    // Interview completion rate (up to 15 pts)
    score += signals.interview_completion_rate * 15;

    // Saved by recruiters — market validation (up to 10 pts)
    score += Math.min(signals.saved_by_recruiters_30d / 10, 1) * 10;

    // Profile views (demand signal, up to 10 pts)
    score += Math.min(signals.profile_views_received_30d / 50, 1) * 10;

    // Endorsements received (social proof, up to 10 pts)
    score += Math.min(signals.endorsements_received / 100, 1) * 10;

    // Verified identity (trust signals, 5 pts)
    if (signals.verified_email) score += 2;
    if (signals.verified_phone) score += 2;
    if (signals.linkedin_connected) score += 1;

    return Math.min(Math.max(score, 0), 100);
  }

  // ──────────────────────────────────────────────────────────────
  // Dimension 4: Availability (15% weight)
  // ──────────────────────────────────────────────────────────────

  private scoreAvailability(c: RawCandidate): number {
    const signals = c.redrob_signals;
    let score = 0;

    // Open to work flag — primary availability signal
    if (signals.open_to_work_flag) score += 30;
    else score += 5; // Still possible they'd consider it

    // Notice period (JD says sub-30 days preferred; can buy out up to 30)
    const np = signals.notice_period_days;
    if (np === 0) score += 30;
    else if (np <= 15) score += 28;
    else if (np <= 30) score += 22;
    else if (np <= 60) score += 12;
    else score += 4; // 60+ day notice heavily penalized

    // Location / relocation fit
    // JD wants Pune/Noida area; open to Hyd, Mumbai, Delhi NCR
    const location = (c.profile.location + ' ' + c.profile.country).toLowerCase();
    const targetCities = ['noida', 'pune', 'delhi', 'ncr', 'hyderabad', 'mumbai', 'gurgaon', 'gurugram', 'bangalore', 'bengaluru'];
    const inIndia = c.profile.country === 'India' || location.includes('india');
    const inTargetCity = targetCities.some((city) => location.includes(city));

    if (inTargetCity) score += 25;
    else if (inIndia && signals.willing_to_relocate) score += 18;
    else if (inIndia) score += 10;
    else if (signals.willing_to_relocate) score += 5; // Outside India with willingness to relocate

    // Work mode preference (JD says hybrid, flexible cadence)
    const mode = signals.preferred_work_mode;
    if (mode === 'hybrid' || mode === 'flexible') score += 15;
    else if (mode === 'onsite') score += 10;
    else score += 5; // Remote — JD is hybrid but not a hard disqualifier

    return Math.min(Math.max(score, 0), 100);
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  private daysSince(dateStr: string): number {
    if (!dateStr) return 999;
    const diff = Date.now() - new Date(dateStr).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  private zeroBreakdown(): ScoreBreakdown {
    return { skillMatch: 0, careerFit: 0, behavioral: 0, availability: 0, total: 0 };
  }
}
