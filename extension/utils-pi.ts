import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

function notify(ui: Pick<ExtensionUIContext, "notify">, message: string, type: "warning" | "error"): void {
  try { ui.notify(`[bash-cmd-checker] ${message}`, type); } catch {}
}

export function notifyWarning(ui: Pick<ExtensionUIContext, "notify">, message: string): void {
  notify(ui, message, "warning");
}

export function notifyError(ui: Pick<ExtensionUIContext, "notify">, message: string): void {
  notify(ui, message, "error");
}
