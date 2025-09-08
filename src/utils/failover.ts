import { log } from "./log";

interface FailoverConfig {
  providers: string[];
  maxRetries: number;
  retryDelay: number;
}

interface ErrorResponse {
  error?: {
    code?: string;
    status?: number;
    message?: string;
  };
  status?: number;
}

export class FailoverManager {
  private failoverConfig: Map<string, FailoverConfig> = new Map();

  constructor(private config: any) {
    this.initializeFailoverConfig();
  }

  private initializeFailoverConfig() {
    const router = this.config.Router || {};
    
    // Create failover chains for each routing scenario
    Object.keys(router).forEach(scenario => {
      if (scenario !== 'longContextThreshold' && router[scenario]) {
        const primaryProvider = router[scenario];
        const fallbacks = this.generateFallbacks(primaryProvider, scenario);
        
        this.failoverConfig.set(scenario, {
          providers: [primaryProvider, ...fallbacks],
          maxRetries: 3,
          retryDelay: 1000
        });
      }
    });
  }

  private generateFallbacks(primaryProvider: string, scenario: string): string[] {
    // First, check if explicit fallbacks are configured
    const explicitFallbacks = this.config.Router?.fallbacks?.[scenario];
    if (explicitFallbacks && Array.isArray(explicitFallbacks)) {
      return explicitFallbacks;
    }
    
    // Fallback to automatic generation
    const fallbacks: string[] = [];
    const availableProviders = this.config.Providers || [];
    
    // Extract primary provider name
    const [primaryProviderName] = primaryProvider.split(',');
    
    // Add fallbacks from different providers
    availableProviders.forEach((provider: any) => {
      if (provider.name !== primaryProviderName && provider.models.length > 0) {
        // Pick a suitable model from this provider
        const fallbackModel = this.selectFallbackModel(provider, scenario);
        if (fallbackModel) {
          fallbacks.push(`${provider.name},${fallbackModel}`);
        }
      }
    });
    
    return fallbacks;
  }

  private selectFallbackModel(provider: any, scenario: string): string | null {
    const models = provider.models || [];
    if (models.length === 0) return null;

    // For different scenarios, prefer different model characteristics
    switch (scenario) {
      case 'longContext':
        // Prefer models with larger context windows
        return models.find((m: string) => 
          m.includes('70b') || m.includes('32b') || m.includes('compound')
        ) || models[0];
      
      case 'background':
        // Prefer smaller, faster models
        return models.find((m: string) => 
          m.includes('8b') || m.includes('7b') || m.includes('instant')
        ) || models[0];
      
      case 'think':
        // Prefer reasoning models
        return models.find((m: string) => 
          m.includes('r1') || m.includes('reasoning') || m.includes('70b')
        ) || models[0];
      
      default:
        return models[0];
    }
  }

  isRateLimitError(error: any): boolean {
    if (!error) return false;
    
    // Check for HTTP 429 status code
    if (error.status === 429 || error.statusCode === 429) {
      return true;
    }
    
    // Check for rate limit in error message
    const message = error.message?.toLowerCase() || '';
    return message.includes('rate limit') || 
           message.includes('too many requests') ||
           message.includes('quota exceeded') ||
           message.includes('rate_limit_exceeded');
  }

  async executeWithFailover(
    scenario: string, 
    requestFn: (provider: string) => Promise<any>
  ): Promise<any> {
    const failoverConfig = this.failoverConfig.get(scenario);
    if (!failoverConfig) {
      throw new Error(`No failover configuration for scenario: ${scenario}`);
    }

    let lastError: any;
    
    for (let i = 0; i < failoverConfig.providers.length; i++) {
      const provider = failoverConfig.providers[i];
      
      try {
        log(`Attempting request with provider: ${provider} (attempt ${i + 1}/${failoverConfig.providers.length})`);
        const result = await requestFn(provider);
        
        if (i > 0) {
          log(`Failover successful: switched from primary to ${provider}`);
        }
        
        return result;
      } catch (error: any) {
        lastError = error;
        
        if (this.isRateLimitError(error)) {
          log(`Rate limit detected for ${provider}, immediately trying next provider (no delay)...`);
          
          // NO DELAY for rate limit errors - immediate failover
          // Rate limited providers should fail fast, waiting won't help
          continue;
        } else {
          // For non-rate-limit errors, fail fast
          log(`Non-rate-limit error for ${provider}:`, error.message);
          throw error;
        }
      }
    }
    
    // All providers failed
    log(`All providers failed for scenario ${scenario}. Last error:`, lastError?.message);
    throw lastError;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getFailoverConfig(scenario: string): FailoverConfig | undefined {
    return this.failoverConfig.get(scenario);
  }

  // Update failover configuration when config changes
  updateConfig(newConfig: any) {
    this.config = newConfig;
    this.failoverConfig.clear();
    this.initializeFailoverConfig();
  }
}