export class ContentError extends Error {
  constructor(public readonly code: 'INVALID_INPUT' | 'FORBIDDEN' | 'UNAVAILABLE' | 'TOO_LARGE',message: string) {
    super(message); this.name = 'ContentError';
  }
}
