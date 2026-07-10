/**
 * DB Pressure Detection & Circuit Breaker
 * 
 * Tracks Supabase 504/timeout errors across the app.
 * When multiple failures accumulate, activates "pressure mode"
 * which tells components to skip optional queries and back off polling.
 */

type PressureState = {
  failCount: number;
  lastFailAt: number;
  pressureActive: boolean;
  pressureActivatedAt: number;
  /** Per-query circuit breaker: queryKey -> consecutive fail count */
  queryFailCounts: Map<string, number>;
};

const state: PressureState = {
  failCount: 0,
  lastFailAt: 0,
  pressureActive: false,
  pressureActivatedAt: 0,
  queryFailCounts: new Map(),
};

const listeners = new Set<() => void>();

const PRESSURE_THRESHOLD = 3; // 3 failures within window → pressure mode
const PRESSURE_WINDOW_MS = 60_000; // 60 seconds
const PRESSURE_COOLDOWN_MS = 120_000; // Stay in pressure mode for 2 min minimum
const CIRCUIT_BREAKER_THRESHOLD = 3; // 3 consecutive fails → stop retrying

function notify() {
  listeners.forEach((fn) => fn());
}

function maybeDecay() {
  const now = Date.now();
  // If no failures for a while and pressure is active, check cooldown
  if (state.pressureActive && now - state.pressureActivatedAt > PRESSURE_COOLDOWN_MS) {
    // Only deactivate if no recent failures
    if (now - state.lastFailAt > PRESSURE_WINDOW_MS) {
      state.pressureActive = false;
      state.failCount = 0;
      state.queryFailCounts.clear();
      notify();
    }
  }
}

/** Call this when any Supabase query returns 504, timeout, or fails to fetch */
export function recordDbFailure(queryKey?: string) {
  const now = Date.now();

  // Reset counter if outside window
  if (now - state.lastFailAt > PRESSURE_WINDOW_MS) {
    state.failCount = 0;
  }

  state.failCount++;
  state.lastFailAt = now;

  if (queryKey) {
    const prev = state.queryFailCounts.get(queryKey) || 0;
    state.queryFailCounts.set(queryKey, prev + 1);
  }

  if (state.failCount >= PRESSURE_THRESHOLD && !state.pressureActive) {
    state.pressureActive = true;
    state.pressureActivatedAt = now;
    console.warn('[db-pressure] Pressure mode ACTIVATED — skipping optional queries');
  }

  notify();
}

/** Call this when a Supabase query succeeds, to reset its circuit breaker */
export function recordDbSuccess(queryKey?: string) {
  if (queryKey) {
    state.queryFailCounts.delete(queryKey);
  }
  maybeDecay();
}

/** Check if a specific query's circuit breaker has tripped */
export function isQueryCircuitOpen(queryKey: string): boolean {
  return (state.queryFailCounts.get(queryKey) || 0) >= CIRCUIT_BREAKER_THRESHOLD;
}

/** Check if DB pressure mode is active */
export function isDbPressureActive(): boolean {
  maybeDecay();
  return state.pressureActive;
}

/** Get the current backoff multiplier for polling intervals */
export function getBackoffMultiplier(): number {
  if (!state.pressureActive) return 1;
  const elapsed = Date.now() - state.pressureActivatedAt;
  // Exponential: 2x at start, 4x after 1min, 8x after 2min, max 8x
  if (elapsed < 60_000) return 2;
  if (elapsed < 120_000) return 4;
  return 8;
}

/** Helper: is an error a DB pressure indicator? */
export function isTimeoutError(error: any): boolean {
  if (!error) return false;
  const msg = typeof error === 'string' ? error : (error?.message || error?.statusText || '');
  const status = error?.status || error?.code;
  return (
    status === 504 ||
    status === 503 ||
    msg.includes('upstream request timeout') ||
    msg.includes('Failed to fetch') ||
    msg.includes('timeout') ||
    msg.includes('TIMEOUT')
  );
}

/** React hook to subscribe to pressure state changes */
import { useState, useEffect, useSyncExternalStore, useCallback } from 'react';

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot() {
  return state.pressureActive;
}

export function useDbPressure() {
  const pressureActive = useSyncExternalStore(subscribe, getSnapshot);

  return {
    pressureActive,
    backoffMultiplier: getBackoffMultiplier(),
    isQueryCircuitOpen,
    recordFailure: recordDbFailure,
    recordSuccess: recordDbSuccess,
  };
}

/**
 * Wrap a Supabase query with a timeout.
 * Returns the result or throws on timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = 8000,
  queryKey?: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (queryKey) recordDbFailure(queryKey);
      reject(new Error(`Query timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (result) => {
        clearTimeout(timer);
        if (queryKey) recordDbSuccess(queryKey);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        if (isTimeoutError(err) && queryKey) {
          recordDbFailure(queryKey);
        }
        reject(err);
      }
    );
  });
}
