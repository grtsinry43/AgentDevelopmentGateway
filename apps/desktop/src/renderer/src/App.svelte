<script lang="ts">
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query'
  import Dashboard from './Dashboard.svelte'
  import { appModel, initialAppModel } from './app-model'

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 10_000
      }
    }
  })

  appModel.mountModelData(() => initialAppModel)
</script>

<QueryClientProvider client={queryClient}>
  <Dashboard />
</QueryClientProvider>
