import { createHash } from 'node:crypto';
import { assertReview, assertSnapshot, assertTimeBatch, validDay } from '../syncSchema.ts';
import type { ProgressSnapshot } from '../syncSchema.ts';
import type { Review } from '../types.ts';
import type { TimeBatch } from '../activity.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badInput(): never {
  throw new HttpError(400, 'INVALID_INPUT', 'Invalid request. Only the documented progress fields are accepted.');
}

/** Reject poisonous keys at every depth, including dictionaries and otherwise ignored fields. */
export function safeJson(value: unknown, depth = 0): void {
  if (depth > 20) badInput();
  if (value === null || typeof value !== 'object') return;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null) badInput();
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) badInput();
    safeJson(child, depth + 1);
  }
}

export function exactObject(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) badInput();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !actual.every((key) => keys.includes(key))) badInput();
}

export function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) badInput();
}

export type Operation =
  | { kind: 'review'; id: string; expected: Review | null; review: Review; day: string }
  | { kind: 'time'; id: string; slices: TimeBatch['slices'] }
  | { kind: 'import'; id: string; state: ProgressSnapshot };

export function parseOperation(kind: Operation['kind'], value: unknown): Operation {
  safeJson(value);
  try {
    if (kind === 'review') {
      exactObject(value, ['id', 'expected', 'review', 'day']);
      assertUuid(value.id);
      assertReview(value.review);
      if (['__proto__', 'constructor', 'prototype'].includes(value.review.cardId)) badInput();
      if (value.expected !== null) assertReview(value.expected);
      if (!validDay(value.day) || typeof value.day !== 'string') badInput();
      if (value.expected !== null && value.expected.cardId !== value.review.cardId) badInput();
      return { kind, id: value.id, expected: value.expected, review: value.review, day: value.day };
    }
    if (kind === 'time') {
      exactObject(value, ['id', 'slices']);
      assertUuid(value.id);
      assertTimeBatch(value);
      return { kind, id: value.id, slices: value.slices };
    }
    exactObject(value, ['id', 'state']);
    assertUuid(value.id);
    assertSnapshot(value.state);
    return { kind, id: value.id, state: value.state };
  } catch {
    badInput();
  }
}

/** Sorting keys makes receipts independent of JSON whitespace/property order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(operation: Operation): string {
  return createHash('sha256').update(canonical(operation)).digest('hex');
}

export function safeAdd(a: number, b: number): number {
  const total = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || !Number.isSafeInteger(total)) badInput();
  return total;
}