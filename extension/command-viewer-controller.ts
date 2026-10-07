import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type KeyId, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { CommandViewer, type CommandSnapshot } from "./command-viewer.ts";
import { DEFAULT_COMMAND_VIEWER_SHORTCUT, isShortcutPress } from "./shortcut.ts";

export interface CommandViewerSource {
  update(snapshot: CommandSnapshot, owner: TUI): void;
  clear(): void;
  dispose(): void;
}

export interface CommandViewerController {
  createSource(): CommandViewerSource;
  dispose(): void;
}

interface ViewerSlot {
  interaction?: ViewerInteraction;
  closingKey?: KeyId;
}

interface ViewerInteraction {
  mounting: boolean;
  hiding: boolean;
  closeRequested: boolean;
  component?: CommandViewer;
  handle?: OverlayHandle;
}

type ViewerUi = Pick<ExtensionUIContext, "theme" | "onTerminalInput">;

/** Owns input and overlay lifetime; command sources cannot close or dispose an open viewer. */
export function createCommandViewerController(
  ui: ViewerUi,
  shortcut: KeyId = DEFAULT_COMMAND_VIEWER_SHORTCUT,
): CommandViewerController {
  // One private slot per controller, reserved throughout synchronous/reentrant creation and closing.
  const slot: ViewerSlot = {};
  let currentSource: { token: symbol; snapshot: CommandSnapshot; owner: TUI } | undefined;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  const closeViewer = (interaction: ViewerInteraction): void => {
    interaction.closeRequested = true;
    interaction.component?.dispose();
    if (interaction.mounting || interaction.hiding) return;
    interaction.hiding = true;
    try {
      interaction.handle?.hide();
      interaction.handle = undefined;
      if (slot.interaction === interaction) slot.interaction = undefined;
    } catch {
      // Keep the slot reserved if hiding fails; a later close can retry without creating a second overlay.
    } finally { interaction.hiding = false; }
  };

  const openViewer = (snapshot: CommandSnapshot, tui: TUI): void => {
    const interaction: ViewerInteraction = { mounting: true, hiding: false, closeRequested: false };
    slot.interaction = interaction;
    try {
      interaction.component = new CommandViewer(snapshot, shortcut, () => ui.theme, () => ({
        width: Math.max(1, Math.floor(tui.terminal.columns * 0.9)),
        height: Math.max(1, Math.floor(tui.terminal.rows * 0.8)),
      }), () => tui.requestRender(), (key) => {
        slot.closingKey = key;
        closeViewer(interaction);
      });
      // Own the public handle; ctx.ui.custom's completion may hide an unrelated last-created overlay.
      interaction.handle = tui.showOverlay(interaction.component, { width: "90%", maxHeight: "80%", anchor: "center" });
    } catch { interaction.closeRequested = true; }
    finally {
      interaction.mounting = false;
      if (disposed || interaction.closeRequested) closeViewer(interaction);
    }
  };

  try {
    unsubscribe = ui.onTerminalInput((data) => {
      if (disposed) return;
      // Closing-key suppression belongs to this controller, not to any live command source.
      if (slot.closingKey && matchesKey(data, slot.closingKey)) {
        if (isKeyRelease(data)) { slot.closingKey = undefined; return { consume: true }; }
        if (isKeyRepeat(data)) return { consume: true };
        slot.closingKey = undefined;
      }
      if (!matchesKey(data, shortcut)) return;
      const source = currentSource;
      if (!slot.interaction && !source) return;
      if (isShortcutPress(data, shortcut)) {
        if (slot.interaction) {
          slot.closingKey = shortcut;
          closeViewer(slot.interaction);
        } else if (source) openViewer(source.snapshot, source.owner);
      }
      return { consume: true };
    });
  } catch {
    // Input-listener failure must not disable command analysis or permission decisions.
  }

  return {
    createSource() {
      const source = Symbol("command-viewer-source");
      let released = false;
      const clear = (): void => {
        if (currentSource?.token === source) currentSource = undefined;
      };
      return {
        update(snapshot, tui) {
          if (disposed || released) return;
          // Only the latest update is retained; clearing it must not restore an older command.
          currentSource = { token: source, snapshot: Object.freeze({ ...snapshot }), owner: tui };
        },
        clear,
        dispose() { released = true; clear(); },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      currentSource = undefined;
      try { unsubscribe?.(); } catch {}
      if (slot.interaction) closeViewer(slot.interaction);
      slot.closingKey = undefined;
    },
  };
}
