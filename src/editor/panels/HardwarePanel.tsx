import { useCallback, useEffect, useRef, useState } from 'react';
import { HardwareDevice } from '@engine/hardware/HardwareDevice';
import { IDENTIFY, defaultRange } from '@engine/hardware/protocol';
import { useEditor } from '../EditorContext';
import { loadHardwareSettings, saveHardwareSettings } from '../hardware/settings';
import { SIMULATED_CHANNELS, SimulatedRig, simulatedRest } from '../hardware/simulated';
import { BAUD_RATES, SerialTransport, isWebSerialAvailable, requestSerialPort } from '../hardware/webSerial';
import { WebSocketTransport } from '../hardware/webSocketTransport';
import { useEditorStore } from '../state/editorStore';

/** Live values at 15 Hz. Sixty React renders a second to watch a potentiometer is not a trade. */
const REFRESH_MS = 66;

/**
 * Attached boards, their channels, and what those channels are reading right now.
 *
 * The panel exists because binding a rig is a *measurement* task before it is an authoring one:
 * you cannot write `A0 -> axis:turn min=120 max=890` until you have watched A0 while turning
 * the knob. So channels update live in edit mode — the engine pumps the bus every frame
 * regardless of Play — and the numbers shown are the raw ones a binding is written against,
 * with the normalized bar beside them for the calibrated view.
 */
export function HardwarePanel() {
  const { engine } = useEditor();
  const visible = useEditorStore((s) => s.hardwareVisible);
  const setVisible = useEditorStore((s) => s.setHardwareVisible);

  const [settings, setSettings] = useState(loadHardwareSettings);
  const [status, setStatus] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const simulated = useRef<SimulatedRig | null>(null);
  const bus = engine.hardware;

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // The simulated board's outbound queue has to be drained whether or not anyone is looking,
  // or a play session with the panel closed accumulates every line the engine ever wrote.
  useEffect(() => engine.events.on('afterUpdate', () => simulated.current?.poll()), [engine]);

  useEffect(() => {
    if (!visible) return;
    let last = 0;
    return engine.events.on('afterUpdate', () => {
      const now = performance.now();
      if (now - last < REFRESH_MS) return;
      last = now;
      refresh();
    });
  }, [engine, visible, refresh]);

  // Connection changes are rare and must not wait for the next refresh tick.
  useEffect(() => {
    const offs = [
      bus.events.on('deviceAdded', refresh),
      bus.events.on('deviceRemoved', refresh),
      bus.events.on('status', refresh),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [bus, refresh]);

  const update = (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveHardwareSettings(next);
  };

  /** Two boards of the same model produce the same slug, so the id is made unique here. */
  const uniqueId = (base: string): string => {
    if (!bus.get(base)) return base;
    for (let n = 2; ; n += 1) if (!bus.get(`${base}${n}`)) return `${base}${n}`;
  };

  const connectSerial = async () => {
    const port = await requestSerialPort();
    if (!port) return;
    const transport = new SerialTransport(port, settings.baudRate);
    const device = new HardwareDevice(transport, { id: uniqueId('serial') });
    bus.add(device);
    await device.open();
    setStatus(device.error ? `Serial: ${device.error}` : null);
    refresh();
  };

  const connectSocket = async () => {
    if (!settings.socketUrl.trim()) return;
    const transport = new WebSocketTransport(settings.socketUrl.trim());
    const device = new HardwareDevice(transport, { id: uniqueId('ws') });
    bus.add(device);
    await device.open();
    setStatus(device.error ? `WebSocket: ${device.error}` : null);
    refresh();
  };

  const addSimulated = async () => {
    if (simulated.current) return;
    const rig = new SimulatedRig(uniqueId('sim'));
    simulated.current = rig;
    bus.add(rig.device);
    await rig.start();
    refresh();
  };

  const remove = (deviceId: string) => {
    if (simulated.current?.device.id === deviceId) simulated.current = null;
    bus.remove(deviceId);
    refresh();
  };

  if (!visible) {
    const count = bus.list().filter((device) => device.connected).length;
    return (
      <button
        className={`hardware-toggle ${count > 0 ? 'live' : ''}`}
        onClick={() => setVisible(true)}
        title="Attached hardware (F9)"
      >
        ⚡ Hardware {count > 0 ? `(${count})` : ''}
      </button>
    );
  }

  const devices = bus.list();

  return (
    <div className="hardware">
      <div className="hardware-header">
        <span>⚡ Hardware</span>
        <span>
          <select
            value={settings.baudRate}
            onChange={(event) => update({ baudRate: Number(event.currentTarget.value) })}
            title="Baud rate for new serial connections"
          >
            {BAUD_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>
          <button onClick={() => setVisible(false)} title="Hide">
            ✕
          </button>
        </span>
      </div>

      <div className="hardware-connect">
        <button onClick={connectSerial} disabled={!isWebSerialAvailable()} title="Pick a USB serial port">
          + USB Serial
        </button>
        <input
          value={settings.socketUrl}
          spellCheck={false}
          placeholder="ws://board.local/ws"
          onChange={(event) => update({ socketUrl: event.currentTarget.value })}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') void connectSocket();
          }}
        />
        <button onClick={connectSocket} title="Connect over WebSocket">
          + Socket
        </button>
        <button onClick={addSimulated} disabled={simulated.current !== null} title="A board made of sliders">
          + Simulated
        </button>
      </div>

      {!isWebSerialAvailable() && (
        <p className="hardware-note">
          This browser has no Web Serial — Chrome and Edge do. A networked board, or a bridge
          next to a USB one, connects over WebSocket instead. See docs/HARDWARE.md.
        </p>
      )}
      {status && <p className="hardware-note error">{status}</p>}

      <div className="hardware-body">
        {devices.length === 0 && (
          <div className="hardware-empty">
            <p>Nothing attached. Connect a board, or add the simulated rig to try the bindings.</p>
            <p className="hardware-note">
              A board announces itself with <code>hello name=… channels=…</code> and then streams{' '}
              <code>A0=512</code> lines. The reference sketch is in{' '}
              <code>firmware/WebGameLink</code>.
            </p>
          </div>
        )}

        {devices.map((device) => (
          <div key={device.id} className={`hardware-device ${device.status}`}>
            <div className="hardware-device-header">
              <span className="hardware-name">{device.name}</span>
              <span className="hardware-id">{device.id}</span>
              <span className={`hardware-status ${device.status}`}>
                {device.error ?? device.status}
              </span>
              <span>
                <button
                  onClick={() => device.send(IDENTIFY.trim())}
                  disabled={!device.connected}
                  title="Ask the board to introduce itself"
                >
                  ?
                </button>
                <button
                  onClick={() => void device.close().then(refresh)}
                  disabled={!device.connected}
                  title="Close the link"
                >
                  ■
                </button>
                <button onClick={() => remove(device.id)} title="Forget this device">
                  ✕
                </button>
              </span>
            </div>

            <div className="hardware-channels">
              {device.list().length === 0 && (
                <div className="hardware-note">
                  No channels yet — the board has not reported one. {device.stats.linesIn} lines in.
                </div>
              )}
              {device.list().map((channel) => {
                const range = defaultRange(channel.channel);
                const unit = range.max === range.min ? 0 : (channel.raw - range.min) / (range.max - range.min);
                return (
                  <div className="hardware-channel" key={channel.channel}>
                    <span className={`hardware-channel-name ${channel.down ? 'down' : ''}`}>
                      {channel.channel}
                    </span>
                    <span className="hardware-bar">
                      <span style={{ width: `${Math.max(0, Math.min(1, unit)) * 100}%` }} />
                    </span>
                    <span className="hardware-raw">{format(channel.raw)}</span>
                  </div>
                );
              })}
            </div>

            {simulated.current?.device.id === device.id && (
              <SimulatedControls rig={simulated.current} onChange={refresh} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The sliders that stand in for a board.
 *
 * Outputs are shown next to them because that is the half nobody can otherwise see: a binding
 * writing `D13=255` to a real rig lights a real lamp on the desk, and with no rig it has to
 * light something here or the output side is untestable.
 */
function SimulatedControls({ rig, onChange }: { rig: SimulatedRig; onChange(): void }) {
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(SIMULATED_CHANNELS.map((channel) => [channel, simulatedRest(channel)])),
  );

  const set = (channel: string, value: number) => {
    setValues((current) => ({ ...current, [channel]: value }));
    rig.set(channel, value);
    onChange();
  };

  const outputs = [...rig.outputs.entries()];

  return (
    <div className="hardware-sim">
      {SIMULATED_CHANNELS.map((channel) =>
        channel.startsWith('A') ? (
          <label key={channel} className="hardware-sim-row">
            <span>{channel}</span>
            <input
              type="range"
              min={0}
              max={1023}
              value={values[channel] ?? 0}
              onChange={(event) => set(channel, Number(event.currentTarget.value))}
            />
            <span className="hardware-raw">{values[channel] ?? 0}</span>
          </label>
        ) : (
          <label key={channel} className="hardware-sim-row">
            <span>{channel}</span>
            <button
              className={values[channel] ? 'active' : ''}
              // Held rather than toggled: a button you press and release is what a binding to a
              // key is actually mapping, and a latching toggle hides edge bugs.
              onPointerDown={() => set(channel, 1)}
              onPointerUp={() => set(channel, 0)}
              onPointerLeave={() => values[channel] && set(channel, 0)}
            >
              {values[channel] ? 'held' : 'press'}
            </button>
            <span className="hardware-raw">{values[channel] ?? 0}</span>
          </label>
        ),
      )}

      <div className="hardware-sim-outputs">
        <span className="hardware-note">Outputs</span>
        {outputs.length === 0 && <span className="hardware-note">— nothing written yet</span>}
        {outputs.map(([channel, value]) => (
          <span key={channel} className="hardware-output">
            <span
              className="hardware-lamp"
              style={{ opacity: 0.15 + Math.min(1, Math.abs(value) / 255) * 0.85 }}
            />
            {channel}={format(value)}
          </span>
        ))}
      </div>
    </div>
  );
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
