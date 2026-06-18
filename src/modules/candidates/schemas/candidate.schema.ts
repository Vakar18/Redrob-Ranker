import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  CandidateProfile,
  CareerEntry,
  Education,
  Skill,
  Certification,
  Language,
  RedrobSignals,
} from '../../../types/candidate.types';

export type CandidateDocument = HydratedDocument<Candidate>;

@Schema({
  collection: 'candidates',
  timestamps: true,
  versionKey: false,
})
export class Candidate {
  @Prop({ required: true, unique: true, index: true })
  candidate_id: string;

  @Prop({ type: Object, required: true })
  profile: CandidateProfile;

  @Prop({ type: [Object], required: true })
  career_history: CareerEntry[];

  @Prop({ type: [Object], default: [] })
  education: Education[];

  @Prop({ type: [Object], default: [] })
  skills: Skill[];

  @Prop({ type: [Object], default: [] })
  certifications: Certification[];

  @Prop({ type: [Object], default: [] })
  languages: Language[];

  @Prop({ type: Object, required: true })
  redrob_signals: RedrobSignals;

  // ── Computed scoring fields (populated after ranking) ──
  @Prop({ type: Number, default: null })
  computed_skill_score: number | null;

  @Prop({ type: Number, default: null })
  computed_career_score: number | null;

  @Prop({ type: Number, default: null })
  computed_behavioral_score: number | null;

  @Prop({ type: Number, default: null })
  computed_availability_score: number | null;

  @Prop({ type: Number, default: null })
  computed_total_score: number | null;

  @Prop({ type: Boolean, default: false })
  is_honeypot: boolean;

  @Prop({ type: String, default: null })
  disqualification_reason: string | null;
}

export const CandidateSchema = SchemaFactory.createForClass(Candidate);

// ── Compound indexes for efficient querying ──
CandidateSchema.index({ computed_total_score: -1 });
CandidateSchema.index({ 'profile.years_of_experience': 1 });
CandidateSchema.index({ 'profile.country': 1 });
CandidateSchema.index({ 'redrob_signals.open_to_work_flag': 1 });
CandidateSchema.index({ 'redrob_signals.last_active_date': -1 });
CandidateSchema.index({ is_honeypot: 1, computed_total_score: -1 });
