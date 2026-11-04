export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  database: string;
  dbType: string;
  wsClients: number;
  timestamp: string;
}
