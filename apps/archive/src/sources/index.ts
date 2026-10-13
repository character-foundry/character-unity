import type { ScraperPlugin } from '@character-unity/scraper-kit';
import { chub } from './chub.js';
import { ct } from './ct.js';
import { risuai } from './risuai.js';
import { wyvern } from './wyvern.js';

/** Every source the Archive can scrape, in the order runs and settings list them. */
export const sources: readonly ScraperPlugin[] = [chub, ct, risuai, wyvern];
