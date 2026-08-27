export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export * from './catalog.js';
export * from './catalog-import.js';
export * from './identity.js';
export * from './gtin.js';
export * from './inci-canonicalization.js';
export * from './inci-correction.js';
export * from './inci.js';
export * from './llm.js';
export * from './mascara-preferences.js';
export * from './media.js';
export * from './ocr.js';
export * from './product-observation.js';
