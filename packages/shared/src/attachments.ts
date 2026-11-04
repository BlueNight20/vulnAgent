export interface EvidenceAttachmentDto {
  id: string; evidenceId: string; filename: string; mimeType: string;
  sha256: string; sizeBytes: number; computedSha256: string; computedSizeBytes: number;
  integrity: 'match' | 'mismatch'; previewable: boolean; sourceUri: string | null;
}
