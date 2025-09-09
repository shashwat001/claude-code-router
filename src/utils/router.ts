import {
  MessageCreateParamsBase,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile } from 'fs/promises'
import { RateLimitTracker } from "./rateLimitTracker";

const enc = get_encoding("cl100k_base");

// Global rate limit tracker
const rateLimitTracker = new RateLimitTracker();

const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getRoutingScenario = (req: any, tokenCount: number, config: any, lastUsage?: Usage | undefined): string => {
  const longContextThreshold = config.Router.longContextThreshold || 60000;
  const lastUsageThreshold =
    lastUsage &&
    lastUsage.input_tokens > longContextThreshold &&
    tokenCount > 20000;
  const tokenCountThreshold = tokenCount > longContextThreshold;

  if ((lastUsageThreshold || tokenCountThreshold) && config.Router.longContext) {
    return 'longContext';
  }

  if (req.body?.system?.length > 1 && req.body?.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")) {
    return 'subagent';
  }

  if (req.body.model?.startsWith("claude-3-5-haiku") && config.Router.background) {
    return 'background';
  }

  if (req.body.thinking && config.Router.think) {
    return 'think';
  }

  if (Array.isArray(req.body.tools) && req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) && config.Router.webSearch) {
    return 'webSearch';
  }

  return 'default';
};

const applyFailoverLogic = async (model: string, scenario: string, config: any): Promise<string | null> => {
  // Get fallback models for this scenario
  const fallbacks = config.Router?.fallbacks?.[scenario] || [];

  // Clean up old rate limit data first
  await rateLimitTracker.cleanup();

  try {
    // Check if the primary provider is available and get the best available model
    const availableModel = await rateLimitTracker.getAvailableProvider(model, fallbacks);

    if (availableModel !== model) {
      log(`Failover activated: ${model} -> ${availableModel} for scenario: ${scenario}`);
    }

    return availableModel;
  } catch (error) {
    // All providers are rate-limited, return null to indicate failure
    log(`Failover failed: ${error.message}`);
    return null;
  }
};

const getUseModel = async (
  req: any,
  tokenCount: number,
  config: any,
  lastUsage?: Usage | undefined
) => {
  if (req.body.model.includes(",")) {
    const [provider, model] = req.body.model.split(",");
    const finalProvider = config.Providers.find(
      (p: any) => p.name.toLowerCase() === provider
    );
    const finalModel = finalProvider?.models?.find(
      (m: any) => m.toLowerCase() === model
    );
    if (finalProvider && finalModel) {
      return `${finalProvider.name},${finalModel}`;
    }
    return req.body.model;
  }

  // if tokenCount is greater than the configured threshold, use the long context model
  const longContextThreshold = config.Router.longContextThreshold || 60000;
  const lastUsageThreshold =
    lastUsage &&
    lastUsage.input_tokens > longContextThreshold &&
    tokenCount > 20000;
  const tokenCountThreshold = tokenCount > longContextThreshold;
  if (
    (lastUsageThreshold || tokenCountThreshold) &&
    config.Router.longContext
  ) {
    req.log.info(
      `Using long context model due to token count: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    return config.Router.longContext;
  }
  if (
    req.body?.system?.length > 1 &&
    req.body?.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")
  ) {
    const model = req.body?.system[1].text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (model) {
      req.body.system[1].text = req.body.system[1].text.replace(
        `<CCR-SUBAGENT-MODEL>${model[1]}</CCR-SUBAGENT-MODEL>`,
        ""
      );
      return model[1];
    }
  }
  // If the model is claude-3-5-haiku, use the background model
  if (
    req.body.model?.startsWith("claude-3-5-haiku") &&
    config.Router.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    return config.Router.background;
  }
  // if exits thinking, use the think model
  if (req.body.thinking && config.Router.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    return config.Router.think;
  }
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    config.Router.webSearch
  ) {
    return config.Router.webSearch;
  }
  return config.Router!.default;
};

export const markProviderRateLimited = async (provider: string, headers?: any) => {
  await rateLimitTracker.markProviderRateLimited(provider, headers);
};

export const router = async (req: any, _res: any, context: any) => {
  const { config, event } = context;
  // Parse sessionId from metadata.user_id
  if (req.body.metadata?.user_id) {
    const parts = req.body.metadata.user_id.split("_session_");
    if (parts.length > 1) {
      req.sessionId = parts[1];
    }
  }
  const lastMessageUsage = sessionUsageCache.get(req.sessionId);
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
<<<<<<< HEAD
  if (config.REWRITE_SYSTEM_PROMPT && system.length > 1 && system[1]?.text?.includes('<env>')) {
    const prompt = await readFile(config.REWRITE_SYSTEM_PROMPT, 'utf-8');
    system[1].text = `${prompt}<env>${system[1].text.split('<env>').pop()}`
  }

=======

>>>>>>> 1ab30f1 (Add intelligent rate limiting and failover system)
  try {
    const tokenCount = calculateTokenCount(
      messages as MessageParam[],
      system,
      tools as Tool[]
    );

    // Determine routing scenario
    const scenario = getRoutingScenario(req, tokenCount, config, lastMessageUsage);
    req.routingScenario = scenario;

    let model;
    if (config.CUSTOM_ROUTER_PATH) {
      try {
        const customRouter = require(config.CUSTOM_ROUTER_PATH);
        req.tokenCount = tokenCount; // Pass token count to custom router
        model = await customRouter(req, config, {
          event
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }
    if (!model) {
      model = await getUseModel(req, tokenCount, config, lastMessageUsage);
    }

    // Apply failover logic to handle rate-limited providers
    const finalModel = await applyFailoverLogic(model, scenario, config);

    if (finalModel === null) {
      // All providers are rate-limited, reject the request
      throw new Error(`Request rejected: All providers are currently rate-limited for scenario '${scenario}'. Please try again later.`);
    }

    req.body.model = finalModel;

    // Store routing information for error handling
    req.routingScenario = scenario;
    req.primaryModel = model;
    req.selectedModel = finalModel;

  } catch (error: any) {
<<<<<<< HEAD
    req.log.error(`Error in router middleware: ${error.message}`);
=======
    log("Error in router middleware:", error.message);

    // If this is a rate limit exhaustion error, don't fallback - let it bubble up
    if (error.message.includes('All providers are currently rate-limited')) {
      throw error;
    }

    // For other router errors, fallback to default
>>>>>>> 1ab30f1 (Add intelligent rate limiting and failover system)
    req.body.model = config.Router!.default;
  }
  return;
};
