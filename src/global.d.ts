export {};

interface ExternalMediaInfo {
  title?: string;
  artist?: string;
  album?: string;
  thumbnail?: string;
  url?: string;
}

interface ExternalMediaStatus {
  isPlaying?: boolean;
  status?: string;
}

declare global {
  interface Window {
    electron?: {
      platform: string;
      onTogglePlay: (callback: () => void) => void;
      togglePlay: () => void;
      onExternalMediaInfo: (callback: (info: ExternalMediaInfo) => void) => (() => void);
      onExternalMediaStatus: (callback: (status: ExternalMediaStatus) => void) => (() => void);
      sendStartListeningExternalMedia: () => void;
      sendStopListeningExternalMedia: () => void;
      getSystemAudioSource: () => Promise<{ id: string; name: string } | null>;
    };
  }
}
