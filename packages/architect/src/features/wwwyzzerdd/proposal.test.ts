import { expect, it } from 'vitest';
import { parseWizardProposal, reviewWizardProposal, applyWizardProposal } from './proposal';

it('recognizes only validated wizard text and tags without accepting arbitrary asset, extension or lineage mutations', () => {
  expect(parseWizardProposal('```json\n{"name":"Aster","description":"A keeper","tags":["forest"]}\n```'))
    .toEqual({ name: 'Aster', description: 'A keeper', tags: ['forest'] });
  for (const value of [{ description: { unsafe: true } }, { tags: 'not-an-array' }, { name: 'Aster', extensions: { foundry: { lineage: 'replaced' } } }, { name: 'Aster', assets: [] }]) {
    expect(parseWizardProposal(JSON.stringify(value))).toBeNull();
  }
  expect(parseWizardProposal('Ordinary prose is still a valid conversation.')).toBeNull();
  expect(parseWizardProposal('{"description":""}')).toEqual({ description: '' });
});

it('filters unsupported existing fields from a generated wizard proposal with visible reasons', () => {
  const data = { description: 'Supported', scenario: false, extensions: { voxta: 0 } };
  expect(reviewWizardProposal({ description: 'Proposed', scenario: 'Do not replace false', appearance: 'Do not replace zero' }, data))
    .toEqual({ fields: { description: 'Proposed' }, blocked: ['Scenario', 'Appearance'] });
  expect(data).toEqual({ description: 'Supported', scenario: false, extensions: { voxta: 0 } });
});

it('rejects the entire reviewed wizard Apply if a currently opaque field would be replaced', () => {
  const data = { description: 'Supported', scenario: false };
  expect(() => applyWizardProposal({ description: 'Proposed', scenario: 'Replacement' }, data)).toThrow('Scenario has a value this form cannot edit.');
  expect(data).toEqual({ description: 'Supported', scenario: false });
});

it('applies supported appearance without changing opaque sibling extensions', () => {
  const data = { extensions: { voxta: { appearance: 'Old', vendor: false }, depth_prompt: 0 } };
  expect(applyWizardProposal({ appearance: 'New' }, data)).toEqual({ extensions: {
    voxta: { appearance: 'New', vendor: false }, depth_prompt: 0,
  } });
  expect(data.extensions.voxta.appearance).toBe('Old');
});
