import { log } from "./log";

interface RateLimitHeaders {
  limit?: string | number;
  remaining?: string | number;
  reset?: string | number;
  retryAfter?: string | number;
  timestamp?: string;
}

interface ProviderStatus {
  rateLimitedUntil: number;
  consecutiveFailures: number;
  lastFailure: number;
  rateLimitHeaders?: RateLimitHeaders;
}

export class RateLimitTracker {
  private providerStatus: Map<string, ProviderStatus> = new Map();
  private readonly cooldownPeriod = 5 * 60 * 1000; // 5 minutes
  
  isProviderRateLimited(provider: string): boolean {
    const status = this.providerStatus.get(provider);
    if (!status) return false;
    
    const now = Date.now();
    return now < status.rateLimitedUntil;
  }
  
  markProviderRateLimited(provider: string, headers?: RateLimitHeaders): void {
    const now = Date.now();
    const status = this.providerStatus.get(provider) || {
      rateLimitedUntil: 0,
      consecutiveFailures: 0,
      lastFailure: 0
    };
    
    status.consecutiveFailures++;
    status.lastFailure = now;
    status.rateLimitHeaders = headers;
    
    // Calculate backoff time based on headers if available
    let backoffTime = this.calculateBackoffTime(headers, status.consecutiveFailures);
    status.rateLimitedUntil = now + backoffTime;
    
    this.providerStatus.set(provider, status);
    
    const resetTime = new Date(status.rateLimitedUntil).toISOString();
    log(`Provider ${provider} marked as rate-limited until ${resetTime}${headers ? ' (based on headers)' : ' (exponential backoff)'}`);
    
    if (headers) {
      log(`Rate limit info - Limit: ${headers.limit}, Remaining: ${headers.remaining}, Reset: ${headers.reset}, RetryAfter: ${headers.retryAfter}`);
    }
  }
  
  private calculateBackoffTime(headers?: RateLimitHeaders, consecutiveFailures: number = 1): number {
    if (!headers) {
      // Fallback to exponential backoff: 5min, 10min, 20min, etc.
      const backoffMultiplier = Math.min(consecutiveFailures, 4);
      return this.cooldownPeriod * backoffMultiplier;
    }
    
    // If retry-after header is present, use it (in seconds)
    if (headers.retryAfter) {
      const retryAfterMs = parseInt(String(headers.retryAfter)) * 1000;
      if (retryAfterMs > 0) {
        return retryAfterMs;
      }
    }
    
    // If reset timestamp is present, calculate time until reset
    if (headers.reset) {
      const resetTime = parseInt(String(headers.reset));
      const now = Math.floor(Date.now() / 1000);
      
      // If reset is a Unix timestamp
      if (resetTime > now) {
        return (resetTime - now) * 1000;
      }
      
      // If reset is relative seconds from now
      if (resetTime > 0 && resetTime < 86400) { // Less than 24 hours
        return resetTime * 1000;
      }
    }
    
    // If remaining is 0, use longer backoff
    if (headers.remaining === 0 || headers.remaining === '0') {
      return this.cooldownPeriod * 2; // 10 minutes
    }
    
    // Default fallback
    const backoffMultiplier = Math.min(consecutiveFailures, 4);
    return this.cooldownPeriod * backoffMultiplier;
  }
  
  markProviderSuccess(provider: string): void {
    const status = this.providerStatus.get(provider);
    if (status) {
      status.consecutiveFailures = 0;
      status.rateLimitedUntil = 0;
    }
  }
  
  getAvailableProvider(primaryModel: string, fallbackModels: string[]): string {
    const primaryProvider = this.getProviderFromModel(primaryModel);
    
    // Check if primary provider is available
    if (!this.isProviderRateLimited(primaryProvider)) {
      return primaryModel;
    }
    
    log(`Primary provider ${primaryProvider} is rate-limited, trying fallbacks...`);
    
    // Try fallback providers
    for (const fallbackModel of fallbackModels) {
      const fallbackProvider = this.getProviderFromModel(fallbackModel);
      if (!this.isProviderRateLimited(fallbackProvider)) {
        log(`Using fallback model: ${fallbackModel}`);
        return fallbackModel;
      }
    }
    
    // CRITICAL CHANGE: When all providers are rate-limited, throw an error instead of cycling
    const errorMessage = `All providers rate-limited: ${primaryProvider} and fallbacks [${fallbackModels.map(m => this.getProviderFromModel(m)).join(', ')}]. Refusing to continue request cycle.`;
    log(errorMessage);
    throw new Error(errorMessage);
  }
  
  getProviderFromModel(model: string): string {
    return model.split(',')[0];
  }
  
  cleanup(): void {
    const now = Date.now();
    for (const [provider, status] of this.providerStatus.entries()) {
      if (now > status.rateLimitedUntil) {
        status.consecutiveFailures = 0;
        status.rateLimitedUntil = 0;
      }
    }
  }
}