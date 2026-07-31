<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { Markdown } from 'svmarkdown'
  import { getHealth } from './api/health'
  import { appModel } from './app-model'

  const title = appModel.selectModelData((model) => model?.title ?? '')
  const intro = appModel.selectModelData((model) => model?.intro ?? '')
  const healthQuery = createQuery(() => ({
    queryFn: getHealth,
    queryKey: ['health']
  }))
</script>

<main>
  <p class="eyebrow">Desktop</p>
  <h1>{$title}</h1>

  <section class="card markdown">
    <Markdown content={$intro} />
  </section>

  <section class="card server-status">
    <div>
      <p class="label">Server</p>
      {#if healthQuery.isPending}
        <p>Connecting to the local server…</p>
      {:else if healthQuery.isError}
        <p class="error">{healthQuery.error.message}</p>
      {:else}
        <p class="success">
          {healthQuery.data.service}: {healthQuery.data.status}
        </p>
      {/if}
    </div>

    <button type="button" onclick={() => healthQuery.refetch()}>Refresh</button>
  </section>

  <p class="platform">Running on {window.desktop.platform}</p>
</main>
