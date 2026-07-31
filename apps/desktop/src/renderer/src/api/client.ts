import { ofetch } from 'ofetch'

const baseURL =
  import.meta.env.RENDERER_VITE_API_BASE_URL ?? 'http://127.0.0.1:3000'

export const apiClient = ofetch.create({
  baseURL,
  retry: 1,
  timeout: 5_000
})