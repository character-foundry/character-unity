import { isRecord } from '../../../lib/card-utils';
import { setValueByPath, type FieldDefinition } from '../config/field-definitions';

export interface FieldValue { value: unknown; editable: boolean }

export function supportsFieldValue(definition: Pick<FieldDefinition, 'type'>, value: unknown): boolean {
  if (value === undefined || definition.type === 'readonly') return true;
  switch (definition.type) {
    case 'text': case 'textarea': case 'extension': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'tags': case 'array': return Array.isArray(value) && value.every(item => typeof item === 'string');
    case 'map': return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
  }
}

function fieldPath(definition: FieldDefinition, data: Record<string, unknown>): string {
  if (definition.id === 'appearance') {
    const extensions = data.extensions;
    if (isRecord(extensions) && Object.hasOwn(extensions, 'voxta')) {
      if (!isRecord(extensions.voxta) || Object.hasOwn(extensions.voxta, 'appearance') || !Object.hasOwn(extensions, 'visual_description')) {
        return 'extensions.voxta.appearance';
      }
    }
    return 'extensions.visual_description';
  }
  return definition.path;
}

/** Missing fields are editable; existing unsupported parents/values stay opaque. */
export function readFieldValue(definition: FieldDefinition, data: Record<string, unknown>): FieldValue {
  if (definition.id === 'timestamps') return { value: {
    creation_date: data.creation_date, modification_date: data.modification_date,
  }, editable: false };
  let value: unknown = data;
  for (const part of fieldPath(definition, data).split('.')) {
    if (value === undefined) return { value, editable: true };
    if (!isRecord(value)) return { value, editable: false };
    value = value[part];
  }
  return { value, editable: supportsFieldValue(definition, value) };
}

/** Changes only this field; unrelated opaque siblings and envelope fields survive. */
export function writeFieldValue(definition: FieldDefinition, data: Record<string, unknown>, value: unknown): { field: string; value: unknown } {
  if (!readFieldValue(definition, data).editable || !supportsFieldValue(definition, value)) {
    throw new Error(`${definition.label} has a value this form cannot edit.`);
  }
  const path = fieldPath(definition, data);
  let updated = setValueByPath(data, path, value);
  if (definition.id === 'character_note' || definition.id === 'character_note_depth') {
    const extensions = updated.extensions as Record<string, unknown>;
    const depth = extensions.depth_prompt as Record<string, unknown>;
    // Defaults apply only to absent properties, never to false, zero, null or
    // opaque sibling values. Editing depth must not replace an opaque prompt.
    const depthPrompt = { ...depth };
    if (!Object.hasOwn(depthPrompt, 'depth')) depthPrompt.depth = 4;
    if (!Object.hasOwn(depthPrompt, 'prompt')) depthPrompt.prompt = '';
    if (!Object.hasOwn(depthPrompt, 'role')) depthPrompt.role = 'system';
    updated = { ...updated, extensions: { ...extensions, depth_prompt: depthPrompt } };
  }
  const field = path.split('.')[0];
  return { field, value: updated[field] };
}
