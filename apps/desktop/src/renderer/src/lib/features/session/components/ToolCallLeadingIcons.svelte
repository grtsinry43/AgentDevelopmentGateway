<script lang="ts">
	import type { ToolCall } from '@agent-gateway/core';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { toolKindIcon } from './tool-display';

	interface Props {
		kind: ToolCall['kind'];
	}

	let { kind }: Props = $props();
</script>

<span class="inline-flex size-4 shrink-0 items-center justify-center text-faint" aria-hidden="true">
	<Icon name="chevron-right" size={9} class="group-open:hidden" />
	<Icon name="chevron-down" size={9} class="hidden group-open:block" />
</span>
<Icon name={toolKindIcon(kind)} size={12} class="shrink-0 text-faint" />
