/**
 * Dependency-injection tokens for the provider ports.
 *
 * Interfaces do not exist at runtime, so each port needs a symbolic token.
 * `ProvidersModule` is the only place these are bound to an implementation —
 * everywhere else, a service asks for the token and receives whatever the
 * configuration selected.
 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
export const VIDEO_PROVIDER = Symbol('VIDEO_PROVIDER');
export const VOICE_PROVIDER = Symbol('VOICE_PROVIDER');
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
export const YOUTUBE_PROVIDER = Symbol('YOUTUBE_PROVIDER');
export const QUEUE_PROVIDER = Symbol('QUEUE_PROVIDER');
