'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

export interface UserSettings {
  // Display settings
  showImagesInGreetings: boolean;
  blurNsfwContent: boolean;
  /** Leave cards tagged NSFW out of library lists entirely. */
  hideNsfw: boolean;

  // Card display: tile size in the library grid, picked from the filter bar.
  cardSize: 'small' | 'medium' | 'large';

  // Content filtering
  bannedTags: string[];  // Tags always left out of library lists ("hidden tags")
}

const defaultSettings: UserSettings = {
  showImagesInGreetings: true,
  blurNsfwContent: true,
  hideNsfw: false,
  cardSize: 'medium',
  bannedTags: [],
};

interface SettingsContextType {
  settings: UserSettings;
  updateSettings: (updates: Partial<UserSettings>) => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

const STORAGE_KEY = 'cardshub-settings';

export function SettingsProvider({ children }: { children: ReactNode }) {
  // Read synchronously so the first library query already respects hidden tags (no SSR here).
  const [settings, setSettings] = useState<UserSettings>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const saved = JSON.parse(stored) as Partial<UserSettings>;
        // Earlier builds stored 'normal' for the medium size.
        const cardSize = saved.cardSize === 'small' || saved.cardSize === 'large' ? saved.cardSize : 'medium';
        return { ...defaultSettings, ...saved, cardSize };
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
    return defaultSettings;
  });

  // Save settings to localStorage when they change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }, [settings]);

  const updateSettings = (updates: Partial<UserSettings>) => {
    setSettings(prev => ({ ...prev, ...updates }));
  };

  const resetSettings = () => {
    setSettings(defaultSettings);
  };

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}

// Hook for SSR-safe settings access
export function useSettingsSafe() {
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setSettings({ ...defaultSettings, ...parsed });
      }
    } catch {
      // Ignore
    }
  }, []);

  return settings;
}
