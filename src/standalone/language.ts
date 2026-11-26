import { translator } from '../language';

export const t = translator(() => process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'en');
