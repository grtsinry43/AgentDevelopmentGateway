# Renderer Guidelines

## Layering

- Window roots only compose the screen and register window-level infrastructure.
- Keep dependencies directed as `features -> shared -> ui`; `ui` must not import `features`.
- Put feature IPC wrappers in `features/<feature>/api.ts`, feature state in focused `.svelte.ts` modules, and presentation in `components/`.
- Business components must not access `window.gateway` or `desktop.*` directly.
- Use `$lib` and `$contract`; avoid deep relative imports across layers.
- Keep one shared `cx` helper. Add primitives only when a real caller establishes their contract.

## Svelte 5

- Use runes mode, snippets, callback props, keyed each blocks, and attachments for element-bound behavior.
- Use `$state` only for reactive values, `$state.raw` for whole-value replacement, and `$derived` for computation.
- Use `$effect` only for subscriptions, resource registration, or DOM synchronization; return cleanup directly.
- Never read and write the same reactive value through an effect call chain. Spread, `+=`, and `++` also read the old value.
- The keymap previously caused `effect_update_depth_exceeded` during mount twice: first through a reactive scope array, then through a reactive `version += 1`. Command registries must keep mutable storage non-reactive and notify readers with a pure-write identity token.
- Use Svelte reactive collections when collection mutations must invalidate consumers.
- Do not globally silence accessibility warnings; a local exception needs a standards-based explanation.

## Interaction

- Keep one window-level keydown listener and route shortcuts through the scoped keymap.
- Derive `KeyHintBar` from active bindings; never advertise an unfinished shortcut.
- Modal scopes block underlying single-key navigation. Bare keys yield to text-entry elements.
- Every pointer-only resize or navigation action needs a keyboard path.
- Register dock panels centrally. Keep the dock a serializable vertical stack; do not add arbitrary floating layouts without an approved design.
- Gate runtime panels with capabilities, not provider names.

## Design

- Keep the interface restrained, dense, tool-like, and keyboard-first. Do not imitate chat-product layouts.
- Define color, typography, spacing, radius, shadow, and semantic status tokens in `lib/styles/theme.css`.
- Components must use the shared status mapping instead of inline status-color conditionals.
- Use Google Sans for Latin UI text, PingFang SC on macOS for Chinese, Noto Sans SC as fallback, and Victor Mono for technical text. Reserve Noto Serif SC for an explicitly approved accent.
- Self-host fonts through Fontsource; keep Latin bundles subsetted and offline-safe.
- Keep the Launcher decoration in negative space in the lower-right quadrant, around half the window width and height.
- Render large decorative grids on canvas and pause work while hidden.
- Reference `~/grtblog/web` only for code quality, component composition, tokens, and visual restraint. Do not copy its SvelteKit routing or directory structure.

## Projection Rules

- Accumulate live deltas only in the current tail; `*.completed` payloads replace projected values as authoritative wholes.
- Rebuild from `SessionSnapshot` after `tail_gap`, `snapshot-required`, or backpressure resync.
- Keep content blocks independently reactive so one streaming block does not rebuild the session tree.
- Preserve unknown extension events for a generic Debug view.

## Smoke Checks

- Launcher: recent-project load, local/remote creation, directory picker, open/remove/pin, theme, key scopes, and restart persistence.
- Project: path/host title, left tabs, sidebar toggles, dock add/close/collapse, pointer and keyboard resize, focus shortcuts, and restart persistence.
