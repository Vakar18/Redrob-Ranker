// ────────────────────────────────────────────────────────────────
// Candidate domain types — mirrors the JSON schema exactly
// ────────────────────────────────────────────────────────────────

export type CompanySize =
  | '1-10' | '11-50' | '51-200' | '201-500'
  | '501-1000' | '1001-5000' | '5001-10000' | '10001+';

export type SkillProficiency = 'beginner' | 'intermediate' | 'advanced' | 'expert';
export type LanguageProficiency = 'basic' | 'conversational' | 'professional' | 'native';
export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'flexible';
export type EducationTier = 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4' | 'unknown';

export interface CandidateProfile {
  anonymized_name: string;
  headline: string;
  summary: string;
  location: string;
  country: string;
  years_of_experience: number;
  current_title: string;
  current_company: string;
  current_company_size: CompanySize;
  current_industry: string;
}

export interface CareerEntry {
  company: string;
  title: string;
  start_date: string;
  end_date: string | null;
  duration_months: number;
  is_current: boolean;
  industry: string;
  company_size: CompanySize;
  description: string;
}

export interface Education {
  institution: string;
  degree: string;
  field_of_study: string;
  start_year: number;
  end_year: number;
  grade?: string | null;
  tier?: EducationTier;
}

export interface Skill {
  name: string;
  proficiency: SkillProficiency;
  endorsements: number;
  duration_months?: number;
}

export interface Certification {
  name: string;
  issuer: string;
  year: number;
}

export interface Language {
  language: string;
  proficiency: LanguageProficiency;
}

export interface SalaryRange {
  min: number;
  max: number;
}

export interface RedrobSignals {
  profile_completeness_score: number;
  signup_date: string;
  last_active_date: string;
  open_to_work_flag: boolean;
  profile_views_received_30d: number;
  applications_submitted_30d: number;
  recruiter_response_rate: number;
  avg_response_time_hours: number;
  skill_assessment_scores: Record<string, number>;
  connection_count: number;
  endorsements_received: number;
  notice_period_days: number;
  expected_salary_range_inr_lpa: SalaryRange;
  preferred_work_mode: WorkMode;
  willing_to_relocate: boolean;
  github_activity_score: number;
  search_appearance_30d: number;
  saved_by_recruiters_30d: number;
  interview_completion_rate: number;
  offer_acceptance_rate: number;
  verified_email: boolean;
  verified_phone: boolean;
  linkedin_connected: boolean;
}

export interface RawCandidate {
  candidate_id: string;
  profile: CandidateProfile;
  career_history: CareerEntry[];
  education: Education[];
  skills: Skill[];
  certifications?: Certification[];
  languages?: Language[];
  redrob_signals: RedrobSignals;
}

// ─────────────────────────────────────────────
// Scoring types
// ─────────────────────────────────────────────

export interface ScoreBreakdown {
  skillMatch: number;       // 0-100: hard+soft skill alignment
  careerFit: number;        // 0-100: trajectory, product vs services, depth
  behavioral: number;       // 0-100: engagement signals
  availability: number;     // 0-100: notice period, open-to-work, response rate
  total: number;            // Weighted composite 0-100
}

export interface RankedCandidate {
  candidate_id: string;
  rank: number;
  score: number;
  reasoning: string;
  breakdown: ScoreBreakdown;
  raw?: RawCandidate;
}

export interface SubmissionRow {
  candidate_id: string;
  rank: number;
  score: number;
  reasoning: string;
}
