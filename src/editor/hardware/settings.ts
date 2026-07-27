const STORAGE = 'web3d-editor.hardware';

export interface HardwareSettings {
  baudRate: number;
  socketUrl: string;
  /**
   * Reopen granted serial ports on load.
   *
   * Off by default, and that is not timidity: opening a serial port toggles DTR, which resets
   * an Arduino. A page that reconnects on every hot reload would reset the board every time a
   * file is saved, which is a memorable way to lose a calibration run.
   */
  autoConnect: boolean;
}

const DEFAULTS: HardwareSettings = {
  baudRate: 115200,
  socketUrl: 'ws://localhost:8787',
  autoConnect: false,
};

/**
 * Which port is plugged in is not stored, and cannot be: a Web Serial port handle is not
 * serializable, and the browser deliberately gives no stable identifier for one. What persists
 * is how to talk to it once it has been picked again.
 */
export function loadHardwareSettings(): HardwareSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<HardwareSettings>;
    return {
      baudRate: typeof parsed.baudRate === 'number' ? parsed.baudRate : DEFAULTS.baudRate,
      socketUrl: typeof parsed.socketUrl === 'string' ? parsed.socketUrl : DEFAULTS.socketUrl,
      autoConnect: parsed.autoConnect === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveHardwareSettings(settings: HardwareSettings): void {
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(settings));
  } catch {
    // Private browsing, or storage disabled. The session still works, it just won't persist.
  }
}
