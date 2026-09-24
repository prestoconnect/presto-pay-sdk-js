/**
 * Gateway timestamps, wire-contract.md §3: `yyyyMMddHHmmss.SSS` at a fixed UTC+08:00.
 *
 * The offset is fixed on purpose. `Asia/Kuala_Lumpur` resolves to +08:00 today, and a zone whose rules can be
 * changed by legislation has no business inside a signature. Shifting the epoch and reading UTC fields also
 * avoids `Intl`, which is not present in every runtime this package supports.
 */

const OFFSET_MS = 8 * 60 * 60 * 1000;
const SHAPE = /^\d{14}\.\d{3}$/;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export function formatGatewayTimestamp(date: Date | number): string {
  const epochMs = typeof date === 'number' ? date : date.getTime();
  if (!Number.isFinite(epochMs)) {
    throw new RangeError('timestamp is not a finite instant');
  }
  const shifted = new Date(epochMs + OFFSET_MS);
  return (
    `${pad(shifted.getUTCFullYear(), 4)}${pad(shifted.getUTCMonth() + 1, 2)}${pad(shifted.getUTCDate(), 2)}` +
    `${pad(shifted.getUTCHours(), 2)}${pad(shifted.getUTCMinutes(), 2)}${pad(shifted.getUTCSeconds(), 2)}` +
    `.${pad(shifted.getUTCMilliseconds(), 3)}`
  );
}

/**
 * Strict by design: 18 characters, digits only, and a real calendar date. `Date.UTC` happily rolls 30 February
 * into 2 March, so the parsed instant is formatted back and compared field by field — a rolling parser would
 * accept a timestamp the gateway never sent and hide the bug that produced it.
 */
export function parseGatewayTimestamp(ts: string): Date {
  if (!SHAPE.test(ts)) {
    throw new RangeError(
      `timestamp ${JSON.stringify(ts)} is not yyyyMMddHHmmss.SSS (18 characters, digits only)`,
    );
  }
  const at = (start: number, end: number): number => Number(ts.slice(start, end));
  const year = at(0, 4);
  const month = at(4, 6);
  const day = at(6, 8);
  const hour = at(8, 10);
  const minute = at(10, 12);
  const second = at(12, 14);
  const millisecond = at(15, 18);

  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - OFFSET_MS;
  const roundTrip = new Date(epochMs + OFFSET_MS);
  const sameInstant =
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() + 1 === month &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hour &&
    roundTrip.getUTCMinutes() === minute &&
    roundTrip.getUTCSeconds() === second;

  if (!sameInstant) {
    throw new RangeError(`timestamp ${JSON.stringify(ts)} is not a calendar date at UTC+08:00`);
  }
  return new Date(epochMs);
}

/**
 * The observed clock offset between this host and the gateway, from any response `ts`. A host with a skewed
 * clock fails every request with error 1005 and has no other way to find out why.
 */
export function clockOffsetMs(gatewayTs: string, now: number): number {
  return now - parseGatewayTimestamp(gatewayTs).getTime();
}
