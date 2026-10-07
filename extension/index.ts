import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initializeTui, registerLifecycle } from "./lifecycle.ts";

export default function setup(pi: ExtensionAPI): void {
  registerLifecycle(pi, async (api, ctx, signal) => {
    const { attachPermissions, unavailableAnalyzer } = await import("./permissions.ts");
    return initializeTui(api, ctx, signal, {
      async loadConfig() {
        const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
        const { loadConfigFrom } = await import("./config.ts");
        return loadConfigFrom(getAgentDir());
      },
      async loadAccessor() {
        const { getPermissionsService } = await import("@gotgenes/pi-permission-system");
        return getPermissionsService;
      },
      analyzer: unavailableAnalyzer,
      attachPermissions,
    });
  });
}
