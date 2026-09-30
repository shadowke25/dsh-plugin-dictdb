/** Registers the stub resolution hook. Load with `node --import`. */
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
