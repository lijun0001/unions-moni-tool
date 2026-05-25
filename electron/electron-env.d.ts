/// <reference types="vite/client" />

/** Vite define，见 vite.config.ts */
declare const __UNIONS_EDITION__: string
declare const __UNIONS_BUILD_TIME_MS__: string
declare const __UNIONS_EXPERIENCE_VALID__: string

interface Window {
  unions: import('./preload/index').UnionsAPI
}
