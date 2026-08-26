export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export * from './catalog.js';
export * from './identity.js';
export * from './gtin.js';
export * from './mascara-preferences.js';
export * from './media.js';
export * from './product-observation.js';
