
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STRIPE_PUBLISHABLE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Google Analytics gtag function declaration
declare global {
  function gtag(command: 'config' | 'event' | 'js', targetId: string | Date, config?: any): void;
}

export {};
