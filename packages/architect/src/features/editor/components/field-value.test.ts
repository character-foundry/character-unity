import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fieldDefinitions } from '../config/field-definitions';
import { FieldRenderer } from './FieldRenderer';
import { readFieldValue, writeFieldValue } from './field-value';

function field(id: string) {
  const definition = fieldDefinitions.find(field => field.id === id);
  if (!definition) throw new Error(`Unknown field ${id}`);
  return definition;
}

describe('native authored-field boundary', () => {
  it.each([null, false, 0, { vendor: true }, ['foreign']])('shows unsupported text %j without editable controls', value => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(createElement(FieldRenderer, { definition: field('creator'), value, onChange }));
    expect(html).toContain('Creator has a value this form cannot edit.');
    expect(html).not.toMatch(/<input|<textarea|<button/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([{ foreign: [false, 0] }, ['hello', false], null, false])('preserves unsupported greeting arrays %j', value => {
    const definition = field('alternate_greetings');
    expect(readFieldValue(definition, { alternate_greetings: value })).toEqual({ value, editable: false });
    const html = renderToStaticMarkup(createElement(FieldRenderer, { definition, value, onChange: () => undefined }));
    expect(html).toContain('Alternate Greetings has a value this form cannot edit.');
    expect(html).not.toMatch(/<textarea|<button/);
  });

  it.each(['opaque', null, false, 0, []])('does not turn an unsupported extension parent %j into an object', value => {
    const data = { extensions: { depth_prompt: value } };
    for (const id of ['character_note', 'character_note_depth']) {
      expect(readFieldValue(field(id), data)).toEqual({ value, editable: false });
      expect(() => writeFieldValue(field(id), data, id === 'character_note' ? 'changed' : 3)).toThrow('cannot edit');
    }
    expect(data).toEqual({ extensions: { depth_prompt: value } });
  });

  it('keeps zero and opaque sibling prompt/role when editing a supported depth', () => {
    const data = { extensions: { depth_prompt: { depth: 0, prompt: false, role: null, vendor: [0, false] } } };
    expect(readFieldValue(field('character_note_depth'), data)).toEqual({ value: 0, editable: true });
    expect(readFieldValue(field('character_note'), data)).toEqual({ value: false, editable: false });
    expect(writeFieldValue(field('character_note_depth'), data, 6)).toEqual({ field: 'extensions', value: {
      depth_prompt: { depth: 6, prompt: false, role: null, vendor: [0, false] },
    } });
  });

  it('creates only absent field parents and preserves a present opaque Voxta extension', () => {
    expect(writeFieldValue(field('appearance'), {}, 'Blue')).toEqual({ field: 'extensions', value: { visual_description: 'Blue' } });
    expect(readFieldValue(field('appearance'), { extensions: { voxta: false } })).toEqual({ value: false, editable: false });
    expect(readFieldValue(field('tagline'), { extensions: null })).toEqual({ value: null, editable: false });
  });

  it('edits the existing visual description without inventing a second appearance in an unrelated Voxta object', () => {
    const data = { extensions: { visual_description: 'Original appearance', voxta: { vendor: false } } };
    expect(readFieldValue(field('appearance'), data)).toEqual({ value: 'Original appearance', editable: true });
    expect(writeFieldValue(field('appearance'), data, 'Edited')).toEqual({ field: 'extensions', value: {
      visual_description: 'Edited', voxta: { vendor: false },
    } });
  });
});
