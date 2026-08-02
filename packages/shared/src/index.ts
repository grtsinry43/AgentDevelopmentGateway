export const APP_NAME = 'Agent Development Gateway'

export interface HealthResponse {
  service: typeof APP_NAME
  status: 'ok'
}

export * from './server-contract.js'
export * from './session-items.js'
