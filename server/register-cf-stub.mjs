// Registers the cloudflare: protocol stub loader (used by `npm run start:node`).
import { register } from 'node:module';

register(new URL('./cf-stub-loader.mjs', import.meta.url));
