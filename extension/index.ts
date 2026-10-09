import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAnalyzer, scheduleDeadline } from "./analysis.ts";
import { classifyCommand } from "./classifier.ts";
import { loadConfigFrom } from "./config.ts";
import { nodeViewerFileDependencies, nodeViewerProcessDependencies } from "./external-viewer-node.ts";
import { initializeTui, registerLifecycle } from "./lifecycle.ts";
import { explainCommand } from "./llm.ts";
import { attachPermissions } from "./permissions.ts";

export default function setup(pi: ExtensionAPI): void {
  registerLifecycle(pi, async (api, ctx, signal) => {
    return initializeTui(api, ctx, signal, {
      async loadConfig() {
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
      externalViewer: { files: nodeViewerFileDependencies, processes: nodeViewerProcessDependencies },
      attachPermissions,
    });
  });
}
