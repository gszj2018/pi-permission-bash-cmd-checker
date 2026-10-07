# pi-permission-bash-cmd-checker

English | [简体中文](./README.zh-CN.md)

A [Pi Coding Agent](https://github.com/earendil-works/pi) extension package that enhances
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
with **bash command explanations and classifier-based risk assessment** in the terminal UI.

## Features

### 1. Command Explanations

See a short explanation of what a bash command does, in English or Simplified Chinese.

### 2. Risk Assessment and Optional Blocking

A classifier (default: `typesafe/jev-latest`) assesses command risk:

| Result    | Display              | Meaning                                           |
|-----------|----------------------|---------------------------------------------------|
| `safe-ro` | ✅  Likely Safe (RO) | Read-only operations that are likely safe.        |
| `safe-rw` | ℹ  Likely Safe (RW)  | Operations that modify data but are likely safe.  |
| `unsafe`  | ⛔  Dangerous        | Operations that may be dangerous.                 |
| `unknown` | ⚠  Unknown          | The risk could not be determined with confidence. |

Set `autoBlockUnsafe` to `true` to block commands assessed as dangerous automatically.
This option is disabled by default.

### 3. Command Preview and Full-Command Viewer

Commands, risk labels, and explanations appear in a live preview above the editor,
where long commands are shown truncated.
Press **Alt+C** to open the full command in a read-only overlay.

## Installation

Requirements:

- A Pi version with **Classifier/Jev support**.
- **`@gotgenes/pi-permission-system` 39.0.3 or later**.

This extension works only in the interactive TUI.

Install as a Pi package:

```bash
# From npm
pi install npm:pi-permission-bash-cmd-checker

# From this GitHub repository
pi install git:github.com/gszj2018/pi-permission-bash-cmd-checker
```

## Usage

### Enable Command Analysis

Add `bash-cmd-checker` to `authorizerChain` in your permission-system configuration, normally at
`~/.pi/agent/extensions/pi-permission-system/config.json`:

```json
{
  "authorizerChain": ["bash-cmd-checker"]
}
```

Keep your existing permission rules and other chain links; placing the checker near the start of the
chain is recommended. Analysis covers bash requests that require approval (`ask`).
Run `/reload` after changing the configuration.
If you use project-level permission settings, make sure the chain in effect also includes the checker.

### Viewer Controls

| Key                                    | Action                                 |
|----------------------------------------|----------------------------------------|
| **Alt+C**, or your configured shortcut | Open or close the full-command viewer. |
| **↑ / ↓**                              | Scroll one line.                       |
| **PgUp / PgDn**                        | Scroll one page.                       |
| **Home / End**                         | Jump to the start or the end.          |
| **Esc / q / Enter**                    | Close the viewer.                      |

Mouse-wheel scrolling is available in fullscreen mode; use keyboard scrolling in regular mode.

## Configuration

Create `~/.pi/agent/bash-cmd-checker.json` to customize the extension, then run `/reload` to apply
your changes. If `PI_CODING_AGENT_DIR` is set, place the file in that directory instead.

All fields are optional. If no configuration file exists, the following defaults apply:

```json
{
  "llm": {
    "model": null,
    "language": "en",
    "timeoutMs": 30000
  },
  "classifier": {
    "model": { "provider": "typesafe", "id": "jev-latest" },
    "timeoutMs": 10000,
    "thresholds": { "safe": 0.5, "unsafe": 0.3, "confidence": 0.8 }
  },
  "widget": { "commandViewerShortcut": "alt+c" },
  "autoBlockUnsafe": false
}
```

See [`schemas/bash-cmd-checker.schema.json`](./schemas/bash-cmd-checker.schema.json) for the full
JSON Schema. An optional `$schema` field enables schema validation in your editor.

### Configuration Fields

| Field                              | Default               | Description                                                                                                                |
|------------------------------------|-----------------------|----------------------------------------------------------------------------------------------------------------------------|
| `llm.model`                        | `null`                | Model used for explanations, in `{ "provider": "…", "id": "…" }` form.<br>`null` uses the current session's default model. |
| `llm.language`                     | `"en"`                | Language for explanations: `en` for English, `zh` for Simplified Chinese.                                                  |
| `llm.timeoutMs`                    | `30000`               | Timeout for explanations, in milliseconds.                                                                                 |
| `classifier.model`                 | `typesafe/jev-latest` | Model used for risk classification, in `{ "provider": "…", "id": "…" }` form.<br>`null` disables risk assessment only.     |
| `classifier.timeoutMs`             | `10000`               | Timeout for risk assessment, in milliseconds.                                                                              |
| `classifier.thresholds.safe`       | `0.5`                 | Minimum probability required for a safe category.                                                                          |
| `classifier.thresholds.unsafe`     | `0.3`                 | Minimum probability required for the unsafe category.                                                                      |
| `classifier.thresholds.confidence` | `0.8`                 | Minimum confidence required to accept an assessment.                                                                       |
| `widget.commandViewerShortcut`     | `"alt+c"`             | Shortcut for opening the full-command viewer.                                                                              |
| `autoBlockUnsafe`                  | `false`               | Automatically block commands assessed as dangerous.                                                                        |

## Notes and Limitations

- Risk labels and thresholds are **not safety guarantees**. This extension never approves commands
  automatically and does not replace permission rules or a sandbox. When analysis fails or is
  unavailable, the permission system still decides whether to approve.
- Only native `bash` requests that require approval are covered. Aliased shell tools, other tools,
  policy decisions, session approvals, yolo approvals, and requests decided by an earlier chain link
  are not analyzed.
- The extension runs only in the interactive TUI. A forwarded bash request from a non-TUI subagent
  can be analyzed by the parent TUI session.
- **Complete commands are sent to the selected model providers without redaction** and may contain
  secrets. Commands and explanations are also visible in the terminal. Review the provider's privacy
  policy before use.
- Background analysis may incur costs that are not automatically included in Pi's session cost display.

## Development

```bash
npm install
npm test
npm run typecheck
```

To load the extension locally from the repository root:

```bash
pi -e ./extension/index.ts
```

The project uses TypeScript and Node.js's built-in test runner.

## Project Structure

```text
pi-permission-bash-cmd-checker/
├── extension/
│   ├── index.ts          # Extension entry point (dependency assembly)
│   ├── lifecycle.ts      # TUI detection, initialization, and session lifecycle
│   ├── config.ts         # Configuration loading and strict validation
│   ├── types.ts          # Shared types and implementation-independent contracts
│   ├── utils.ts          # Shared predicates
│   ├── command.ts        # Full bash command extraction
│   ├── utils-pi.ts       # Prefixed notifications with failure fallback
│   ├── permissions.ts    # Service binding, event parsing, and arbitration
│   ├── analysis.ts       # Parallel analysis tasks, deadlines, and cancellation
│   ├── llm.ts            # Explanation model adapter
│   ├── classifier.ts     # Classifier model adapter
│   ├── risk.ts           # Risk threshold decisions
│   ├── state.ts          # Session state, generations, and records
│   ├── widget.ts         # Preview widget and command source port
│   ├── command-viewer.ts # Locked full-command overlay and controller
│   ├── shortcut.ts       # Viewer shortcut parsing
│   └── terminal-text.ts  # Colors, safe escaping, and wrapping
├── schemas/
│   └── bash-cmd-checker.schema.json
└── tests/                # Unit and integration tests
```

## License

[MIT](./LICENSE)
