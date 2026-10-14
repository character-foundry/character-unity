import { z } from 'zod';
import { getFieldById } from '../editor/config/field-definitions';
import { readFieldValue, writeFieldValue } from '../editor/components/field-value';

const text = z.string().max(100_000);
const schema = z.object({ name: z.string().max(500), nickname: z.string().max(500), description: text, scenario: text,
  first_mes: text, appearance: z.string().max(10_000), personality: text, tags: z.array(z.string().max(200)).max(100) }).partial().strict();
export type WizardFields = z.infer<typeof schema>;

/** Conversation text is allowed, but only this explicit field proposal can
 * enable Apply. Model output cannot replace assets or protected extensions. */
export function parseWizardProposal(content: string): WizardFields | null {
  if (content.length > 1_048_576) return null;
  const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const result = schema.safeParse(JSON.parse(match[1] ?? match[0]));
    return result.success && Object.keys(result.data).length ? result.data : null;
  } catch { return null; }
}

export function reviewWizardProposal(proposal: WizardFields, data: Record<string, unknown>): { fields: WizardFields; blocked: string[] } {
  const fields: WizardFields = {}, blocked: string[] = [];
  for (const [key, value] of Object.entries(proposal)) {
    const definition = getFieldById(key);
    if (!definition || !readFieldValue(definition, data).editable) {
      blocked.push(definition?.label ?? key);
    } else Object.assign(fields, { [key]: value });
  }
  return { fields, blocked };
}

/** Recheck the current raw document before one atomic draft update. */
export function applyWizardProposal(proposal: WizardFields, data: Record<string, unknown>): Record<string, unknown> {
  const review = reviewWizardProposal(proposal, data);
  if (review.blocked.length) throw new Error(`${review.blocked.join(', ')} has a value this form cannot edit.`);
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(review.fields)) {
    const change = writeFieldValue(getFieldById(key)!, { ...data, ...changes }, value);
    changes[change.field] = change.value;
  }
  return changes;
}
