/** Deployment profile switches. The internal (self-hosted) profile hides social features. */
export const features = {
  social: import.meta.env.VITE_UNITY_SOCIAL === 'true',
} as const;
