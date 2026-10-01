// @nestjs/throttler ships CommonJS while @nestjs/common is ESM-only. Jest's
// require(esm) bridge rejects the resulting cycle unless the CommonJS package is
// loaded first, so this file must stay in `setupFiles` (it runs before tests).
import '@nestjs/throttler';
