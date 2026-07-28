import { useCallback, useEffect, useState } from 'react';
import { HardwareDevice } from '@engine/hardware/HardwareDevice';
import { IDENTIFY, defaultRange } from '@engine/hardware/protocol';
import { useEditor } from '../EditorContext';
import { loadHardwareSettings, saveHardwareSettings } from '../hardware/settings';
import { SIMULATED_CHANNELS, SimulatedRig, simulatedRest } from '../hardware/simulated';
import { BAUD_RATES, SerialTransport, isWebSerialAvailable, requestSerialPort } from '../hardware/webSerial';
import { WebSocketTransport } from '../hardware/webSocketTransport';

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
 *
 * In v0.7.4 it became a tab in the bottom dock instead of a 300px column pinned over the left
 * of the viewport — where it sat on top of the Graphics panel, which claimed the same corner.
 * Devices now lay out side by side, which is what a two-board rig actually needs.
 */
export function HardwarePanel() {
  const { engine, simulatedRig, addSimulatedRig, removeSimulatedRig } = useEditor();

  const [settings, setSettings] = useState(loadHardwareSettings);
  const [status, setStatus] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const bus = engine.hardware;

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Only while mounted, which the dock now means literally: switch to another tab and the
  // 15 Hz re-render stops with it, rather than running for the rest of the session because a
  // floating panel was left open behind the viewport.
  useEffect(() => {
    let last = 0;
    return engine.events.on('afterUpdate', () => {
      const now = performance.now();
      if (now - last < REFRESH_MS) return;
      last = now;
      refresh();
    });
  }, [engine, refresh]);

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
    await addSimulatedRig(uniqueId('sim'));
    refresh();
  };

  const remove = (deviceId: string) => {
    if (simulatedRig()?.device.id === deviceId) removeSimulatedRig();
    bus.remove(deviceId);
    refresh();
  };

  const devices = bus.list();
  const rig = simulatedRig();

  return (
    <div className="panel-content">
      <div className="panel-bar">
        <button onClick={connectSerial} disabled={!isWebSerialAvailable()} title="Pick a USB serial port">
          + USB Serial
        </button>
        <label className="inline-field" title="Baud rate for new serial connections">
          Baud
          <select
            value={settings.baudRate}
            onChange={(event) => update({ baudRate: Number(event.currentTarget.value) })}
          >
            {BAUD_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>
        </label>
        <input
          className="panel-search"
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
        <button onClick={addSimulated} disabled={rig !== null} title="A board made of sliders">
          + Simulated
        </button>
      </div>

      {!isWebSerialAvailable() && (
        <p className="note panel-note">
          This browser has no Web Serial — Chrome and Edge do. A networked board, or a bridge
          next to a USB one, connects over WebSocket instead. See docs/HARDWARE.md.
        </p>
      )}
      {status && <p className="note error panel-note">{status}</p>}

      <div className="panel-scroll">
        {devices.length === 0 ? (
          <div className="empty-note">
            <p>Nothing attached. Connect a board, or add the simulated rig to try the bindings.</p>
            <p>
              A board announces itself with <code>hello name=… channels=…</code> and then streams{' '}
              <code>A0=512</code> lines. The reference sketch is in{' '}
              <code>firmware/WebGameLink</code>.
            </p>
          </div>
        ) : (
          <div className="device-grid">
            {devices.map((device) => (
              <div key={device.id} className={`device ${device.status}`}>
                <div className="device-header">
                  <span className={`device-dot ${device.status}`} />
                  <span className="device-name">{device.name}</span>
                  <span className="device-id">{device.id}</span>
                  <span className="device-actions">
                    <button
                      className="icon-button"
                      onClick={() => device.send(IDENTIFY.trim())}
                      disabled={!device.connected}
                      title="Ask the board to introduce itself"
                    >
                      ?
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => void device.close().then(refresh)}
                      disabled={!device.connected}
                      title="Close the link"
                    >
                      ■
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => remove(device.id)}
                      title="Forget this device"
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div className={`device-status ${device.status}`}>
                  {device.error ?? device.status}
                </div>

                <div className="channels">
                  {device.list().length === 0 && (
                    <div className="note">
                      No channels yet — the board has not reported one. {device.stats.linesIn}{' '}
                      lines in.
                    </div>
                  )}
                  {device.list().map((channel) => {
                    const range = defaultRange(channel.channel);
                    const unit =
                      range.max === range.min
                        ? 0
                        : (channel.raw - range.min) / (range.max - range.min);
                    return (
                      <div className="channel" key={channel.channel}>
                        <span className={`channel-name ${channel.down ? 'down' : ''}`}>
                          {channel.channel}
                        </span>
                        <span className="meter">
                          <span style={{ width: `${Math.max(0, Math.min(1, unit)) * 100}%` }} />
                        </span>
                        <span className="channel-raw">{format(channel.raw)}</span>
                      </div>
                    );
                  })}
                </div>

                {rig?.device.id === device.id && (
                  <SimulatedControls rig={rig} onChange={refresh} />
                )}
              </div>
            ))}
          </div>
        )}
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
    <div className="sim-rig">
      {SIMULATED_CHANNELS.map((channel) =>
        channel.startsWith('A') ? (
          <label key={channel} className="channel">
            <span className="channel-name">{channel}</span>
            <input
              type="range"
              min={0}
              max={1023}
              value={values[channel] ?? 0}
              onChange={(event) => set(channel, Number(event.currentTarget.value))}
            />
            <span className="channel-raw">{values[channel] ?? 0}</span>
          </label>
        ) : (
          <label key={channel} className="channel">
            <span className="channel-name">{channel}</span>
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
            <span className="channel-raw">{values[channel] ?? 0}</span>
          </label>
        ),
      )}

      <div className="sim-outputs">
        <span className="note">Outputs</span>
        {outputs.length === 0 && <span className="note">— nothing written yet</span>}
        {outputs.map(([channel, value]) => (
          <span key={channel} className="sim-output">
            <span
              className="lamp"
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
