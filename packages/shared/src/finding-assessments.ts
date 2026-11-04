import type { Severity } from './enums';
export interface FindingMetadata {
  title: string; description: string; severity: Severity; cve: string | null; cwe: string | null; cvss: number | null; remediation: string | null;
}
export interface FindingAssessmentInput extends FindingMetadata {
  expectedRevision: number; note: string; evidenceQuotes: { evidenceId: string; quote: string }[];
}
export interface FindingAssessmentDto {
  id: string; taskId: string; findingId: string; revision: number; metadata: FindingMetadata; note: string;
  evidenceQuotes: { evidenceId: string; quote: string }[]; createdAt: string; valid: boolean; issues: string[];
  previousMetadata?: FindingMetadata;
}
