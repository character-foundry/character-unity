'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

export interface UserSettings {
  // Display settings
  showImagesInGreetings: boolean;
  blurNsfwContent: boolean;
  sidebarExpanded: boolean;

  // Card display
  cardSize: 'normal' | 'large';

  // Content filtering
  bannedTags: string[];  // Tag slugs to exclude from explore results
}

const defaultSettings: UserSettings = {
  showImagesInGreetings: true,
  blurNsfwContent: true,
  sidebarExpanded: false,
  cardSize: 'large',
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
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load settings from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setSettings({ ...defaultSettings, ...parsed });
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
    setIsLoaded(true);
  }, []);

  // Save settings to localStorage when they change
  useEffect(() => {
    if (isLoaded) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch (e) {
        console.error('Failed to save settings:', e);
      }
    }
  }, [settings, isLoaded]);

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
