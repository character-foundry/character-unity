import type { Card, CCv2Data } from './types';
import type { CCv3DataInner } from '@character-foundry/character-foundry/schemas';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Locate an existing envelope, not validate or normalize its authored fields. */
export function isCharacterEnvelope(value: unknown): value is Record<string, unknown> & { spec: 'chara_card_v2' | 'chara_card_v3'; data: Record<string, unknown> } {
  return isRecord(value) && (value.spec === 'chara_card_v2' || value.spec === 'chara_card_v3') && isRecord(value.data);
}

/**
 * Extract actual card data fields from card.data, handling both wrapped and unwrapped formats
 * V2 can be: { spec, spec_version, data: {...} } or just {...}
 * V3 is always: { spec, spec_version, data: {...} }
 * Lorebook and Collection cards use V3 structure internally
 */
export function extractCardData(card: Card): CCv2Data | CCv3DataInner {
  const data = card.data;

  // Optional fields may contain opaque values. A strict SDK validation failure
  // must never change which layer an editor reads or writes.
  if (isCharacterEnvelope(data)) return data.data as unknown as CCv2Data | CCv3DataInner;
  return data as CCv2Data;
}
