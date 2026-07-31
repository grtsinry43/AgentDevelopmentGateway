import type { HealthResponse } from '@agent-gateway/shared'
import { apiClient } from './client'

export function getHealth(): Promise<HealthResponse> {
  return apiClient<HealthResponse>('/health')
}
