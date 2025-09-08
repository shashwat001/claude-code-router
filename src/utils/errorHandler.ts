import { log } from "./log";

export interface FailoverRequest extends Request {
  failoverManager?: any;
  routingScenario?: string;
  primaryModel?: string;
  failoverAttempts?: number;
  maxFailoverAttempts?: number;
  body?: any;
}

export class ErrorHandler {
  private maxRetries = 3;
  private retryDelay = 1000;

  async handleRequestError(
    req: FailoverRequest, 
    reply: any, 
    error: any,
    config: any,
    server: any
  ): Promise<boolean> {
    // Check if this is a rate limit error and failover is available
    if (!this.isRateLimitError(error) || !req.failoverManager) {
      return false; // Let normal error handling proceed
    }

    // Extract and log rate limit headers for tracking
    this.extractRateLimitHeaders(error, req.body?.model);

    const currentAttempts = req.failoverAttempts || 0;
    const maxAttempts = req.maxFailoverAttempts || this.maxRetries;

    if (currentAttempts >= maxAttempts) {
      log(`Maximum failover attempts (${maxAttempts}) reached for request`);
      return false;
    }

    log(`Rate limit detected, attempting immediate failover to next provider (attempt ${currentAttempts + 1}/${maxAttempts})`);
    
    try {
      // Get next provider from failover manager
      const scenario = req.routingScenario || 'default';
      const failoverConfig = req.failoverManager.getFailoverConfig(scenario);
      
      if (!failoverConfig || failoverConfig.providers.length <= currentAttempts + 1) {
        log(`No more fallback providers available for scenario: ${scenario}`);
        return false;
      }

      const nextProvider = failoverConfig.providers[currentAttempts + 1];
      log(`Switching to fallback provider: ${nextProvider}`);

      // Update request for retry
      req.body.model = nextProvider;
      req.failoverAttempts = currentAttempts + 1;

      // NO DELAY for 429 errors - immediate failover
      // Rate limited providers should fail fast, not retry with delay

      // Retry the request with new provider
      await this.retryRequest(req, reply, config, server);
      
      return true; // Failover handled successfully
    } catch (retryError) {
      log(`Failover retry failed:`, retryError);
      return false;
    }
  }

  private async retryRequest(
    req: FailoverRequest, 
    reply: any, 
    config: any, 
    server: any
  ): Promise<void> {
    try {
      // Re-route the request internally
      const originalUrl = req.url;
      const originalMethod = req.method;
      
      // Use server's internal request handler to retry
      const response = await fetch(`http://127.0.0.1:${config.PORT}${originalUrl}`, {
        method: originalMethod,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.APIKEY || 'retry',
          'x-retry-attempt': String(req.failoverAttempts)
        },
        body: JSON.stringify(req.body)
      });

      if (!response.ok) {
        throw new Error(`Retry request failed with status: ${response.status}`);
      }

      // Stream the response back
      if (response.body) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/plain',
          'Transfer-Encoding': 'chunked'
        });
        
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(value);
          }
        } finally {
          reader.releaseLock();
          reply.raw.end();
        }
      } else {
        reply.send(await response.text());
      }
    } catch (error) {
      log(`Internal retry failed:`, error);
      throw error;
    }
  }

  private isRateLimitError(error: any): boolean {
    if (!error) return false;
    
    // Check for HTTP 429 status code
    if (error.status === 429 || error.statusCode === 429) {
      return true;
    }
    
    // Check for rate limit in error message
    const message = error.message?.toLowerCase() || '';
    const errorString = JSON.stringify(error).toLowerCase();
    
    return message.includes('rate limit') || 
           message.includes('too many requests') ||
           message.includes('quota exceeded') ||
           message.includes('rate_limit_exceeded') ||
           errorString.includes('rate limit') ||
           errorString.includes('too many requests');
  }

  private extractRateLimitHeaders(error: any, model?: string): void {
    try {
      const headers = error?.response?.headers || error?.headers || {};
      const rateLimitData: any = {
        timestamp: new Date().toISOString(),
        model: model || 'unknown',
        provider: model?.split(',')[0] || 'unknown'
      };

      // Extract common rate limit headers
      if (headers['x-ratelimit-limit']) {
        rateLimitData.limit = headers['x-ratelimit-limit'];
      }
      if (headers['x-ratelimit-remaining']) {
        rateLimitData.remaining = headers['x-ratelimit-remaining'];
      }
      if (headers['x-ratelimit-reset']) {
        rateLimitData.reset = headers['x-ratelimit-reset'];
      }
      if (headers['retry-after']) {
        rateLimitData.retryAfter = headers['retry-after'];
      }

      // Log the rate limit info
      log(`Rate limit headers extracted:`, JSON.stringify(rateLimitData, null, 2));

      // Store to file for analysis
      this.saveRateLimitData(rateLimitData);
    } catch (extractError) {
      log(`Failed to extract rate limit headers:`, extractError);
    }
  }

  private async saveRateLimitData(data: any): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      
      const rateLimitFile = path.join(os.homedir(), '.claude-code-router', 'rate-limits.json');
      
      // Ensure directory exists
      const dir = path.dirname(rateLimitFile);
      await fs.mkdir(dir, { recursive: true });

      // Read existing data or create empty array
      let rateLimitHistory: any[] = [];
      try {
        const existingData = await fs.readFile(rateLimitFile, 'utf-8');
        rateLimitHistory = JSON.parse(existingData);
      } catch {
        // File doesn't exist or is invalid, start fresh
      }

      // Add new entry
      rateLimitHistory.push(data);

      // Keep only last 1000 entries to prevent file from growing too large
      if (rateLimitHistory.length > 1000) {
        rateLimitHistory = rateLimitHistory.slice(-1000);
      }

      // Write back to file
      await fs.writeFile(rateLimitFile, JSON.stringify(rateLimitHistory, null, 2));
      log(`Rate limit data saved to: ${rateLimitFile}`);
    } catch (saveError) {
      log(`Failed to save rate limit data:`, saveError);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}