import { SetMetadata } from '@nestjs/common';

export interface RateLimitOptions {
  max: number;
  windowSeconds: number;
}

export const RATE_LIMIT_KEY = 'rateLimit';
export const SKIP_RATE_LIMIT_KEY = 'skipRateLimit';
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);
