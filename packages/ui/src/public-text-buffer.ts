export { createTextBuffer } from './text-buffer.js';
export type { TextBufferOptions, TextBufferSource, TextBufferState } from './text-buffer.js';
export type TextBuffer = ReturnType<typeof import('./text-buffer.js').createTextBuffer>;
