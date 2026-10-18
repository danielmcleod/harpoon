# Third-party notices

Harpoon is MIT licensed (see `LICENSE`). This repository also contains code from others, under their own licenses.

## Codex app-server protocol types

`src/core/adapters/codex/protocol/v0.160.0/` holds TypeScript types generated from the
[OpenAI Codex CLI](https://github.com/openai/codex) protocol (with ts-rs).

Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0. You may obtain a copy of the license at
<https://www.apache.org/licenses/LICENSE-2.0>. These files are unmodified generated output.

## Dependencies

npm dependencies are installed by pnpm and are not part of this repository; each keeps its own license. A
packaged build bundles some of them into the app, and electron-builder adds Electron's and Chromium's license
files next to the executable.

`@anthropic-ai/claude-agent-sdk` is a development dependency used only for its type declarations. It is
covered by Anthropic's terms, is not redistributed here, and none of its code ships in the app.
