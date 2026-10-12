import { GptTokenizer } from '@character-foundry/character-foundry/tokenizers';
import { validateTokenTexts } from './tokens.js';

// Foundry's pinned GptTokenizer.encode uses gpt-tokenizer 3.4.0/o200k_base.
// Its count() method silently approximates failures; use the throwing primitive.
const tokenizer = new GptTokenizer();
self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    validateTokenTexts(event.data);
    self.postMessage({ counts: event.data.map((text) => tokenizer.encode(text).length) });
  } catch {
    // Never return source text or tokenizer exceptions that may contain it.
    self.postMessage({ error: 'This text could not be tokenized. Reserved token markers or unsupported input may be present.' });
  }
};
