import { treaty } from '@elysiajs/eden';
import type { App } from '@/server/index';

export const api = treaty<App>(process.env.API_URL || 'http://localhost:8080');
