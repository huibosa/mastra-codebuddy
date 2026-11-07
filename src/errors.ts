// A provider said "slow down"; the caller should back off and retry.
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export const RATE_LIMIT = /\b429\b|rate.?limit|too many requests|频率|限流/i;
