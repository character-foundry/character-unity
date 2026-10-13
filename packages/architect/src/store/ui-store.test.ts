import { describe, expect, it } from 'vitest';
import { createUIStore } from './ui-store';

describe('editor-owned controls', () => {
  it('does not synchronize tabs or advanced controls between mounted editors', () => {
    const first = createUIStore(), second = createUIStore();
    first.getState().setActiveTab('assets');
    first.getState().setShowAdvanced(true);
    expect(first.getState().activeTab).toBe('assets');
    expect(second.getState().activeTab).toBe('edit');
    expect(second.getState().showAdvanced).toBe(false);
  });
});
