# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

-   **Build the project**:
    ```bash
    npm run build
    ```
-   **Start the router server**:
    ```bash
    ccr start
    ```
-   **Stop the router server**:
    ```bash
    ccr stop
    ```
-   **Check the server status**:
    ```bash
    ccr status
    ```
-   **Run Claude Code through the router**:
    ```bash
    ccr code "<your prompt>"
    ```
-   **Release a new version**:
    ```bash
    npm run release
    ```

## Architecture

This project is a TypeScript-based router for Claude Code requests. It allows routing requests to different large language models (LLMs) from various providers based on custom rules.

### Core Components

-   **Entry Point**: The main command-line interface logic is in `src/cli.ts`. It handles parsing commands like `start`, `stop`, and `code`.
-   **Server**: The `ccr start` command launches a server that listens for requests from Claude Code. The server logic is initiated from `src/index.ts`.
-   **Configuration**: The router is configured via a JSON file located at `~/.claude-code-router/config.json`. This file defines API providers, routing rules, and custom transformers. An example can be found in `config.example.json`.
-   **Routing**: The core routing logic determines which LLM provider and model to use for a given request. It supports default routes for different scenarios (`default`, `background`, `think`, `longContext`, `webSearch`) and can be extended with a custom JavaScript router file. The router logic is in `src/utils/router.ts`.
-   **Claude Code Integration**: When a user runs `ccr code`, the command is forwarded to the running router service. The service then processes the request, applies routing rules, and sends it to the configured LLM. If the service isn't running, `ccr code` will attempt to start it automatically.
-   **Agent System**: Built-in agent framework (`src/agents/`) that can intercept requests, add tools, and process responses before forwarding to the LLM.
-   **Dependencies**: The project is built with `esbuild`. It has a key local dependency `@musistudio/llms`, which contains the core logic for interacting with different LLM APIs.
-   `@musistudio/llms` is implemented based on `fastify` and exposes `fastify`'s hook and middleware interfaces, allowing direct use of `server.addHook`.

### LLM Interaction Architecture

The router uses a **two-layer architecture** for LLM interactions:

#### 1. Router Layer (claude-code-router)
- **Model Selection**: Analyzes requests and selects appropriate models based on:
  - Token count (switches to long-context models for large inputs)
  - Request type (background, thinking, web search)
  - Custom routing rules
  - Provider-model combinations (format: `provider,model`)

#### 2. LLM Service Layer (@musistudio/llms)
- **Provider Transformers**: Each LLM provider has a dedicated transformer that handles API format conversion:
  - **Anthropic** - Native Claude API
  - **OpenAI** - GPT models
  - **Google** - Gemini models (regular and Vertex AI)
  - **DeepSeek** - DeepSeek models
  - **Groq** - Fast inference
  - **Cerebras** - Cerebras models
  - **OpenRouter** - Multiple providers

#### 3. Transformation Process
Each transformer implements four key methods:
```typescript
transformRequestIn()   // Standardize incoming request
transformRequestOut()  // Convert to provider's API format
transformResponseIn()  // Convert provider's response to standard format
transformResponseOut() // Return standardized response
```

This architecture allows Claude Code to work with **any LLM provider** while maintaining a consistent interface, with automatic format translation and intelligent routing based on request characteristics.

- dont make long function, add fucntion whereever you can for better readbility. also dont add chinese comment
- always make logical group of changes in a file together, not one by one so that i can review all together