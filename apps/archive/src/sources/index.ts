import type { ScraperPlugin } from '@character-unity/scraper-kit';
import { chub } from './chub.js';

/** Every source the Archive can scrape, in the order runs and settings list them. */
export const sources: readonly ScraperPlugin[] = [chub];
