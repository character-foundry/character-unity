import { describe, expect, it } from 'vitest';
import { tileMenuPosition } from './menu-position';

describe('native tile menu viewport placement', () => {
  it('opens a dense first-row menu below the footer rather than behind the header', () => {
    expect(tileMenuPosition({ top: 220, bottom: 248, right: 160 }, { width: 176, height: 206 }, { width: 1440, height: 1000 })).toEqual({ below: true, shiftX: 24, maxHeight: 740 });
  });
  it('opens above a lower tile and keeps both viewport edges reachable', () => {
    expect(tileMenuPosition({ top: 720, bottom: 748, right: 390 }, { width: 176, height: 206 }, { width: 390, height: 844 })).toEqual({ below: false, shiftX: -8, maxHeight: 660 });
    expect(tileMenuPosition({ top: 320, bottom: 348, right: 160 }, { width: 176, height: 206 }, { width: 390, height: 844 })).toEqual({ below: false, shiftX: 24, maxHeight: 260 });
  });
  it('provides a scrollable height when a short landscape viewport cannot fit the menu either way', () => {
    expect(tileMenuPosition({ top: 150, bottom: 178, right: 160 }, { width: 176, height: 206 }, { width: 812, height: 375 })).toMatchObject({ below: true, maxHeight: 185 });
  });
});
