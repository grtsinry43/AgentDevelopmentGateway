# Runtime Package Guidelines

## Boundaries
- `core` defines provider-neutral domain, adapter, event, error, and wire contracts.
- `adapter-*` maps provider APIs into core contracts and namespaced extension events.
- `runtime` owns sessions, monotonic sequence numbers, persistence, replay, backpressure, and snapshots.
- Provider SDK types must not cross an adapter package boundary.

## Events and Capabilities
- Adapters emit normalized events without assigning host sequence numbers.
- Runtime stamps sequence numbers and persists lifecycle events in an append-only log.
- Do not persist `LIVE_ONLY_EVENT_TYPES`; they are high-frequency presentation tails.
- Treat completed payloads and snapshots as authoritative whole values.
- Model replay gaps explicitly with `tail_gap`, `snapshot-required`, or backpressure; never invent missing history.
- Keep `RuntimeCapabilities` as the feature gate. Preserve provider-native features through capabilities, degradations, raw data, or namespaced extensions.
- Do not reduce providers to the lowest common feature set, and do not branch shared code on `adapterId`.

## Adapter Work
- Verify the installed provider SDK version and official documentation before implementing an API call.
- Keep streaming input open when provider control operations require a live session.
- Map provider messages in a dedicated mapper that can be tested with recorded fixtures.
- Implement the smallest real vertical slice first: connect, create, stream text, tool lifecycle, interaction resolution, interrupt, and terminal result.
- Add contract fixtures before runtime/server integration so adapter behavior is observable without a full UI stack.
