import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initializeTui, registerLifecycle } from "./lifecycle.ts";

export default function setup(pi: ExtensionAPI): void {
  registerLifecycle(pi, async (api, ctx, signal) => {
    const { attachPermissions } = await import("./permissions.ts");
    const { createAnalyzer, scheduleDeadline } = await import("./analysis.ts");
    const { explainCommand } = await import("./llm.ts");
    const { classifyCommand } = await import("./classifier.ts");
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
      createAnalyzer(context, config) {
        return createAnalyzer(config, {
          explain: (command, child) => explainCommand(context, config.llm, command, child),
          classify: (command, child) => classifyCommand(context, config.classifier, command, child),
          schedule: scheduleDeadline,
        });
      },
      attachPermissions,
    });
  });
}
