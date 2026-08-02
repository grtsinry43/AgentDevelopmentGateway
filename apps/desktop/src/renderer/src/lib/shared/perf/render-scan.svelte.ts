/**
 * 渲染热点高亮(自实现)开关。状态栏按钮控制,PerfTools 据此挂载/卸载覆盖层。
 * 不复用 svelte-render-scan 的 UI —— 库的 JS 行为不可改,换成自己的轻量实现。
 */
export const renderScan = $state({ enabled: false });
