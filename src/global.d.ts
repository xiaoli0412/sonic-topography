export {};

declare global {
  interface Window {
    electron?: {
      platform: string;
      onTogglePlay: (callback: () => void) => void;
      togglePlay: () => void;
    };
  }
}
