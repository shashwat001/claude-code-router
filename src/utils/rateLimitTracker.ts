import { log } from "./log";
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

interface RateLimitHeaders {
  'x-ratelimit-limit'?: string | number;
  'x-ratelimit-remaining'?: string | number;
  'x-ratelimit-reset'?: string | number;
  'retry-after'?: string | number;
  timestamp?: string;
}

interface ProviderStatus {
  rateLimitedUntil: number;
  lastFailure: number;
  rateLimitHeaders?: RateLimitHeaders;
}

export class RateLimitTracker {
  private providerStatus: Map<string, ProviderStatus> = new Map();
  private readonly cooldownPeriod = 5 * 60 * 1000; // 5 minutes
  private readonly rateLimitFile: string;
  private loaded = false;
  
  constructor() {
    this.rateLimitFile = path.join(os.homedir(), '.claude-code-router', 'rate-limits.json');
  }
  
  async isProviderRateLimited(provider: string): Promise<boolean> {
    // Ensure data is loaded from file
    await this.ensureLoaded();
    
    const status = this.providerStatus.get(provider);
    if (!status) return false;
    
    const now = Date.now();
    const isRateLimited = now < status.rateLimitedUntil;
    
    if (isRateLimited) {
      const resetTime = new Date(status.rateLimitedUntil).toISOString();
      log(`Provider ${provider} is rate-limited until ${resetTime} (loaded from persistent storage)`);
    }
    
    return isRateLimited;
  }
  
  async markProviderRateLimited(provider: string, headers?: RateLimitHeaders): Promise<void> {
    const now = Date.now();
    const status = this.providerStatus.get(provider) || {
      rateLimitedUntil: 0,
      lastFailure: 0
    };
    
    status.lastFailure = now;
    status.rateLimitHeaders = headers;
    
    // Set rate limit until midnight of the current day
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0); // Next midnight
    status.rateLimitedUntil = midnight.getTime();
    
    this.providerStatus.set(provider, status);
    
    const resetTime = new Date(status.rateLimitedUntil).toISOString();
    log(`Provider ${provider} marked as rate-limited until ${resetTime} (until midnight)`);
    
    if (headers) {
      log(`Rate limit info - Limit: ${headers['x-ratelimit-limit']}, Remaining: ${headers['x-ratelimit-remaining']}, Reset: ${headers['x-ratelimit-reset']}, RetryAfter: ${headers['retry-after']}`);
    }
    
    // Save to persistent storage
    await this.saveToFile();
  }
  
  
  
  async getAvailableProvider(primaryModel: string, fallbackModels: string[]): Promise<string> {
    const primaryProvider = this.getProviderFromModel(primaryModel);
    
    // Check if primary provider is available
    if (!(await this.isProviderRateLimited(primaryProvider))) {
      return primaryModel;
    }
    
    log(`Primary provider ${primaryProvider} is rate-limited, trying fallbacks...`);
    
    // Try fallback providers
    for (const fallbackModel of fallbackModels) {
      const fallbackProvider = this.getProviderFromModel(fallbackModel);
      if (!(await this.isProviderRateLimited(fallbackProvider))) {
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
  
  async cleanup(): Promise<void> {
    await this.ensureLoaded();
    const now = Date.now();
    let changed = false;
    
    for (const [provider, status] of this.providerStatus.entries()) {
      if (now > status.rateLimitedUntil) {
        status.rateLimitedUntil = 0;
        changed = true;
        log(`Provider ${provider} rate limit expired, marking as available`);
      }
    }
    
    if (changed) {
      await this.saveToFile();
    }
  }
  
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    
    try {
      await this.loadFromFile();
    } catch (error) {
      log(`Could not load rate limit data, starting fresh: ${error.message}`);
    }
    this.loaded = true;
  }
  
  private async loadFromFile(): Promise<void> {
    try {
      const data = await fs.readFile(this.rateLimitFile, 'utf-8');
      const parsed = JSON.parse(data);
      
      // Convert the plain object back to Map with ProviderStatus objects
      if (parsed && typeof parsed === 'object') {
        for (const [provider, statusData] of Object.entries(parsed)) {
          this.providerStatus.set(provider, statusData as ProviderStatus);
        }
        log(`Loaded rate limit data for ${Object.keys(parsed).length} providers`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { // File not found is ok, other errors are not
        log(`Error loading rate limit file: ${error.message}`);
      }
    }
  }
  
  private async saveToFile(): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.rateLimitFile), { recursive: true });
      
      // Convert Map to plain object for JSON serialization
      const dataToSave = Object.fromEntries(this.providerStatus);
      
      await fs.writeFile(this.rateLimitFile, JSON.stringify(dataToSave, null, 2));
      log(`Saved rate limit data to ${this.rateLimitFile}`);
    } catch (error) {
      log(`Error saving rate limit file: ${error.message}`);
    }
  }
}