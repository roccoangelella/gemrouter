import { randomUUID } from 'node:crypto';

import { GeminiApiProviderError } from './errors.js';
import type { GeminiApiQuotaLedger } from './quotaLedger.js';
import type { GeminiApiKeyConfig, GeminiApiProviderConfig } from './types.js';

export interface GeminiApiKeyReservation {
  key: GeminiApiKeyConfig;
  model: string;
  requestId: string;
  estimatedTokens: number;
}

export interface GeminiApiLocalBackpressure {
  waitMs: number;
  reason: 'rpm' | 'tpm' | 'cooldown';
  keyId: string;
  quotaGroup: string;
}

/** A live catalog can veto models an account no longer serves upstream. */
export interface AccountModelGate {
  allows(accountId: string, model: string): boolean;
}

export function keyMatchesOwner(key: { userId?: string | null }, ownerUserId?: string): boolean {
  return ownerUserId ? key.userId === ownerUserId : !key.userId;
}

function allowsModel(key: GeminiApiKeyConfig, model: string, gate?: AccountModelGate): boolean {
  const curated = !key.models || key.models.length === 0 || key.models.includes(model);
  return curated && (gate?.allows(key.id, model) ?? true);
}

function capacityScore(input: {
  rpmRemaining: number | null;
  tpmRemaining: number | null;
  rpdRemaining: number | null;
  limit: { rpm: number | null; tpm: number | null; rpd: number | null };
}): number {
  const rpmRatio = input.limit.rpm && input.rpmRemaining !== null ? input.rpmRemaining / input.limit.rpm : 1;
  const tpmRatio = input.limit.tpm && input.tpmRemaining !== null ? input.tpmRemaining / input.limit.tpm : 1;
  const rpdRatio = input.limit.rpd && input.rpdRemaining !== null ? input.rpdRemaining / input.limit.rpd : 1;
  return rpmRatio * 30 + tpmRatio * 30 + rpdRatio * 30;
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rotationTimestamp(input: { lastSuccessAt?: string; lastUsedAt?: string }): number {
  return parseTimestamp(input.lastSuccessAt) || parseTimestamp(input.lastUsedAt);
}

function hasUnresolvedAuthFailure(input: { lastFailureAt?: string; lastFailureCode?: string; lastSuccessAt?: string }): boolean {
  if (input.lastFailureCode !== 'gemini_api_auth_failed') return false;
  const failureAt = parseTimestamp(input.lastFailureAt);
  if (failureAt <= 0) return false;
  return failureAt >= parseTimestamp(input.lastSuccessAt);
}

function recentFailurePenalty(input: {
  modelLast429At?: string | null;
  modelRateLimitStrikes?: number;
  keyLastFailureAt?: string;
  keyLastFailureCode?: string;
}): number {
  const now = Date.now();
  let penalty = 0;
  const model429At = parseTimestamp(input.modelLast429At ?? undefined);
  if (model429At > 0) {
    const ageMs = now - model429At;
    if (ageMs < 60 * 60_000) {
      penalty += 200 + Math.max(0, 60 * 60_000 - ageMs) / 60_000;
      penalty += (input.modelRateLimitStrikes ?? 0) * 100;
    }
  }
  const keyFailureAt = parseTimestamp(input.keyLastFailureAt);
  if (input.keyLastFailureCode === 'gemini_api_rate_limited' && keyFailureAt > 0) {
    const ageMs = now - keyFailureAt;
    if (ageMs < 15 * 60_000) {
      penalty += 120 + Math.max(0, 15 * 60_000 - ageMs) / 60_000;
    }
  }
  return penalty;
}

export class GeminiApiKeyPool {
  constructor(
    private readonly config: GeminiApiProviderConfig,
    private readonly ledger: GeminiApiQuotaLedger,
    private readonly accountModelGate?: AccountModelGate,
  ) {}

  nextLocalBackpressure(
    model: string,
    estimatedTokens: number,
    options?: {
      excludeKeyIds?: string[];
      allowedKeyIds?: string[];
      ownerUserId?: string;
    },
  ): GeminiApiLocalBackpressure | null {
    const excludedKeyIds = new Set((options?.excludeKeyIds ?? []).map((value) => value.trim()).filter(Boolean));
    const allowedKeyIds = options?.allowedKeyIds && options.allowedKeyIds.length > 0
      ? new Set(options.allowedKeyIds.map((value) => value.trim()).filter(Boolean))
      : null;
    const waits = this.config.keys
      .filter((key) => key.enabled)
      .filter((key) => !hasUnresolvedAuthFailure(this.ledger.getKeyState(key.id)))
      .filter((key) => !allowedKeyIds || allowedKeyIds.has(key.id))
      .filter((key) => keyMatchesOwner(key, options?.ownerUserId))
      .filter((key) => allowsModel(key, model, this.accountModelGate))
      .filter((key) => !excludedKeyIds.has(key.id))
      .map((key) => ({ key, availability: this.ledger.getAvailability(key.quotaGroup, model, estimatedTokens) }))
      .filter((entry) => (entry.availability.reason === 'rpm' || entry.availability.reason === 'tpm' || entry.availability.reason === 'cooldown') && typeof entry.availability.waitMs === 'number')
      .filter((entry) => {
        if (entry.availability.reason !== 'cooldown') return true;
        return entry.availability.cooldownSource === '429-backoff' || entry.availability.cooldownSource === 'retry-after';
      })
      .sort((left, right) => (left.availability.waitMs ?? Number.MAX_SAFE_INTEGER) - (right.availability.waitMs ?? Number.MAX_SAFE_INTEGER));

    const next = waits[0];
    if (!next || typeof next.availability.waitMs !== 'number') return null;
    return {
      waitMs: next.availability.waitMs,
      reason: next.availability.reason as 'rpm' | 'tpm' | 'cooldown',
      keyId: next.key.id,
      quotaGroup: next.key.quotaGroup,
    };
  }

  reserve(
    model: string,
    estimatedTokens: number,
    options?: {
      excludeKeyIds?: string[];
      allowedKeyIds?: string[];
      ownerUserId?: string;
    },
  ): GeminiApiKeyReservation {
    if (!this.config.enabled) {
      throw new GeminiApiProviderError('backend_disabled', 'Gemini API backend is disabled.', {
        statusCode: 503,
        fallbackEligible: true,
      });
    }
    if (this.config.keys.length === 0) {
      throw new GeminiApiProviderError('gemini_api_missing_key', 'No Gemini API keys are configured.', {
        statusCode: 503,
        fallbackEligible: true,
      });
    }

    const excludedKeyIds = new Set((options?.excludeKeyIds ?? []).map((value) => value.trim()).filter(Boolean));
    const allowedKeyIds = options?.allowedKeyIds && options.allowedKeyIds.length > 0
      ? new Set(options.allowedKeyIds.map((value) => value.trim()).filter(Boolean))
      : null;
    const keyOrder = new Map(this.config.keys.map((key, index) => [key.id, index]));
    const candidates = this.config.keys
      .filter((key) => key.enabled)
      .filter((key) => !allowedKeyIds || allowedKeyIds.has(key.id))
      .filter((key) => keyMatchesOwner(key, options?.ownerUserId))
      .filter((key) => allowsModel(key, model, this.accountModelGate))
      .filter((key) => !excludedKeyIds.has(key.id))
      .map((key) => {
        const availability = this.ledger.getAvailability(key.quotaGroup, model, estimatedTokens);
        const keyState = this.ledger.getKeyState(key.id);
        return {
          key,
          availability,
          keyState,
          rotationAt: rotationTimestamp(keyState),
          order: keyOrder.get(key.id) ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .filter((candidate) => !hasUnresolvedAuthFailure(candidate.keyState))
      .filter((candidate) => candidate.availability.available)
      .sort((left, right) => {
        if (left.key.priority !== right.key.priority) {
          return right.key.priority - left.key.priority;
        }
        const capacityDelta = capacityScore({
          rpmRemaining: right.availability.rpmRemaining,
          tpmRemaining: right.availability.tpmRemaining,
          rpdRemaining: right.availability.rpdRemaining,
          limit: right.availability.limit,
        }) - recentFailurePenalty({
          modelLast429At: right.availability.last429At,
          modelRateLimitStrikes: right.availability.rateLimitStrikes,
          keyLastFailureAt: right.keyState.lastFailureAt,
          keyLastFailureCode: right.keyState.lastFailureCode,
        }) - (capacityScore({
          rpmRemaining: left.availability.rpmRemaining,
          tpmRemaining: left.availability.tpmRemaining,
          rpdRemaining: left.availability.rpdRemaining,
          limit: left.availability.limit,
        }) - recentFailurePenalty({
          modelLast429At: left.availability.last429At,
          modelRateLimitStrikes: left.availability.rateLimitStrikes,
          keyLastFailureAt: left.keyState.lastFailureAt,
          keyLastFailureCode: left.keyState.lastFailureCode,
        }));
        if (Math.abs(capacityDelta) > 0.001) return capacityDelta;
        if (left.rotationAt !== right.rotationAt) {
          return left.rotationAt - right.rotationAt;
        }
        return left.order - right.order;
      });

    if (candidates.length === 0) {
      const anyForModel = this.config.keys.some((key) =>
        key.enabled &&
        !hasUnresolvedAuthFailure(this.ledger.getKeyState(key.id)) &&
        (!allowedKeyIds || allowedKeyIds.has(key.id)) &&
        keyMatchesOwner(key, options?.ownerUserId) &&
        allowsModel(key, model, this.accountModelGate),
      );
      throw new GeminiApiProviderError(
        anyForModel ? 'gemini_api_quota_unavailable' : 'gemini_api_no_key_for_model',
        anyForModel
          ? `No Gemini API quota group is currently available for ${model}.`
          : `No enabled Gemini API key allows model ${model}.`,
        {
          statusCode: anyForModel ? 429 : 503,
          fallbackEligible: true,
        },
      );
    }

    const selected = candidates[0].key;
    const requestId = randomUUID();
    this.ledger.reserve({
      quotaGroup: selected.quotaGroup,
      keyId: selected.id,
      model,
      estimatedTokens,
      requestId,
    });
    return { key: selected, model, requestId, estimatedTokens };
  }
}
