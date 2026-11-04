export interface ModelBudgetDto {
  tokenBudget: number; usableTokens: number; knownTokens: number; committedTokens: number; remainingTokens: number; total: number; note: string;
  items: { id: string; sessionId: string; currentRun: boolean; state: 'reserved' | 'settled' | 'uncertain' | 'cancelled'; modelName: string;
    inputEstimate: number; maxOutputTokens: number; reservedTokens: number; committedTokens: number;
    inputTokens: number | null; outputTokens: number | null; costUsd: number | null; errorMessage: string | null; createdAt: string; finishedAt: string | null }[];
}
