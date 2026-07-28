import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HardwareDevice } from '@engine/hardware/HardwareDevice';
import { IDENTIFY, defaultRange } from '@engine/hardware/protocol';
import { useEditor } from '../EditorContext';
import { loadHardwareSettings, saveHardwareSettings } from '../hardware/settings';
import {
  BOARD_PROFILES,
  DEFAULT_BOARD_PROFILE,
  SimulatedRig,
  findBoardProfile,
  simulatedRest,
} from '../hardware/simulated';
import { BAUD_RATES, SerialTransport, isWebSerialAvailable, requestSerialPort } from '../hardware/webSerial';
import { WebSocketTransport } from '../hardware/webSocketTransport';
import { WebBluetoothTransport, isWebBluetoothAvailable, requestBluetoothDevice } from '../hardware/webBluetooth';

/** Live values at 15 Hz. Sixty React renders a second to watch a potentiometer is not a trade. */
const REFRESH_MS = 66;
/** Scrollback for the raw serial monitor. A rig streaming at 8ms/channel fills this in ~2.5s. */
const MONITOR_LINES_MAX = 300;
/** History kept per channel for the plotter, in samples (not seconds — see the graph's own note). */
const GRAPH_SAMPLES_MAX = 180;

interface MonitorLine {
  direction: 'in' | 'out';
  text: string;
}

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
  const [profileId, setProfileId] = useState<string>(DEFAULT_BOARD_PROFILE.id);
  const [tick, setTick] = useState(0);
  const [monitoring, setMonitoring] = useState<Set<string>>(new Set());
  const bus = engine.hardware;

  /**
   * Raw lines and per-channel value history, kept outside React state because they update far
   * faster than a render is worth (every line, every write) and are read back only for the
   * device whose monitor is actually open — see `refresh`, which is the one thing that turns a
   * mutation here into a re-render, at the same throttled rate as the channel meters.
   */
  const monitorRef = useRef(new Map<string, MonitorLine[]>());
  const historyRef = useRef(new Map<string, Map<string, number[]>>());

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const toggleMonitor = (deviceId: string) => {
    setMonitoring((current) => {
      const next = new Set(current);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  const clearMonitor = (deviceId: string) => {
    monitorRef.current.set(deviceId, []);
    historyRef.current.set(deviceId, new Map());
    refresh();
  };

  // Every line, either direction, on every device — bounded per device so a chatty rig cannot
  // grow this without limit while the panel sits open for a whole session.
  useEffect(() => {
    return bus.events.on('line', ({ deviceId, direction, text }) => {
      const lines = monitorRef.current.get(deviceId) ?? [];
      lines.push({ direction, text });
      if (lines.length > MONITOR_LINES_MAX) lines.splice(0, lines.length - MONITOR_LINES_MAX);
      monitorRef.current.set(deviceId, lines);
    });
  }, [bus]);

  useEffect(() => {
    return bus.events.on('deviceRemoved', ({ deviceId }) => {
      monitorRef.current.delete(deviceId);
      historyRef.current.delete(deviceId);
    });
  }, [bus]);

  // Only while mounted, which the dock now means literally: switch to another tab and the
  // 15 Hz re-render stops with it, rather than running for the rest of the session because a
  // floating panel was left open behind the viewport.
  useEffect(() => {
    let last = 0;
    return engine.events.on('afterUpdate', () => {
      const now = performance.now();
      if (now - last < REFRESH_MS) return;
      last = now;
      // Sampled at the same rate the panel redraws at — a plot does not need to be denser than
      // it can be seen, and sampling only the devices whose monitor is open means a rig sitting
      // unwatched in the corner of the panel costs nothing.
      for (const deviceId of monitoring) {
        const device = bus.get(deviceId);
        if (!device) continue;
        const perChannel = historyRef.current.get(deviceId) ?? new Map<string, number[]>();
        historyRef.current.set(deviceId, perChannel);
        for (const { channel, raw } of device.list()) {
          const series = perChannel.get(channel) ?? [];
          series.push(raw);
          if (series.length > GRAPH_SAMPLES_MAX) series.splice(0, series.length - GRAPH_SAMPLES_MAX);
          perChannel.set(channel, series);
        }
      }
      refresh();
    });
  }, [engine, bus, monitoring, refresh]);

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

  const connectBluetooth = async () => {
    const device = await requestBluetoothDevice();
    if (!device) return;
    const transport = new WebBluetoothTransport(device);
    const hwDevice = new HardwareDevice(transport, { id: uniqueId('ble') });
    bus.add(hwDevice);
    await hwDevice.open();
    setStatus(hwDevice.error ? `Bluetooth: ${hwDevice.error}` : null);
    refresh();
  };

  const addSimulated = async () => {
    await addSimulatedRig(uniqueId('sim'), findBoardProfile(profileId));
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
        <button
          onClick={connectBluetooth}
          disabled={!isWebBluetoothAvailable()}
          title="Pick a Nordic UART Service (NUS) Bluetooth device"
        >
          + Bluetooth
        </button>
        <label className="inline-field" title="Which virtual board '+ Simulated' adds">
          Board
          <select
            value={profileId}
            disabled={rig !== null}
            onChange={(event) => setProfileId(event.currentTarget.value)}
          >
            {BOARD_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>
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
                      className={`icon-button ${monitoring.has(device.id) ? 'active' : ''}`}
                      onClick={() => toggleMonitor(device.id)}
                      title="Raw serial monitor and a live graph of every channel"
                    >
                      ▤
                    </button>
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

                {monitoring.has(device.id) && (
                  <DeviceMonitor
                    lines={monitorRef.current.get(device.id) ?? []}
                    history={historyRef.current.get(device.id) ?? new Map()}
                    tick={tick}
                    onClear={() => clearMonitor(device.id)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const GRAPH_COLORS = ['#5dd0ff', '#ffb454', '#8dff8d', '#ff7ab8', '#c9a4ff', '#ffe066', '#7ae8ff', '#ff9d7a'];

function channelColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length]!;
}

/**
 * The raw serial monitor and a live plot, together, because they answer the same question two
 * ways: "channel `A0`" as text you can compare against what you typed into the Arduino IDE, and
 * as a line you can watch settle — a jittery pot and a stuck-at-zero one look identical as a
 * number scrolling past but nothing alike as a trace.
 *
 * The plot's x-axis is samples, not seconds — `HardwarePanel` only samples channels for a device
 * whose monitor is open, at the panel's own 15 Hz refresh, so "the last `GRAPH_SAMPLES_MAX`
 * samples" is closer to a few seconds than a precise span. Good enough for "is this centred and
 * how noisy is it", which is what calibration actually needs.
 */
function DeviceMonitor({
  lines,
  history,
  tick,
  onClear,
}: {
  lines: MonitorLine[];
  history: Map<string, number[]>;
  /** Bumped by the panel's refresh loop — the only prop this reads to know it should redraw. */
  tick: number;
  onClear(): void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const channels = useMemo(() => [...history.keys()], [history, tick]);

  // Sticks to the bottom unless the user has scrolled up to read something older.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i += 1) {
      const y = Math.round((height / 4) * i) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    channels.forEach((channel, index) => {
      const series = history.get(channel);
      if (!series || series.length < 2) return;
      const range = defaultRange(channel);
      const span = range.max - range.min || 1;
      ctx.strokeStyle = channelColor(index);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      series.forEach((raw, i) => {
        const unit = Math.max(0, Math.min(1, (raw - range.min) / span));
        const x = (i / (GRAPH_SAMPLES_MAX - 1)) * width;
        const y = height - unit * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }, [channels, history, tick]);

  return (
    <div className="hw-monitor">
      <div className="hw-monitor-graph">
        <canvas ref={canvasRef} width={280} height={80} />
        <div className="hw-monitor-legend">
          {channels.length === 0 && <span className="note">No channels sampled yet.</span>}
          {channels.map((channel, index) => (
            <span key={channel} className="hw-monitor-legend-item">
              <span className="hw-monitor-swatch" style={{ background: channelColor(index) }} />
              {channel}
            </span>
          ))}
        </div>
      </div>
      <div className="hw-monitor-log-bar">
        <span className="note">
          Serial monitor — {lines.length} of {MONITOR_LINES_MAX}
        </span>
        <button className="icon-button" onClick={onClear} title="Clear">
          ✕
        </button>
      </div>
      <div className="hw-monitor-log" ref={logRef}>
        {lines.length === 0 && <div className="note">Nothing yet.</div>}
        {lines.map((line, index) => (
          <div key={index} className={`hw-monitor-line ${line.direction}`}>
            <span className="hw-monitor-dir">{line.direction === 'in' ? '←' : '→'}</span>
            <span className="hw-monitor-text">{line.text.replace(/\n+$/, '')}</span>
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
    Object.fromEntries(
      rig.channels.map((channel) => [channel, simulatedRest(channel, rig.profile)]),
    ),
  );

  const set = (channel: string, value: number) => {
    setValues((current) => ({ ...current, [channel]: value }));
    rig.set(channel, value);
    onChange();
  };

  const outputs = [...rig.outputs.entries()];

  return (
    <div className="sim-rig">
      {rig.channels.map((channel) =>
        channel.startsWith('A') ? (
          <label key={channel} className="channel">
            <span className="channel-name">{channel}</span>
            <input
              type="range"
              min={0}
              max={rig.profile.adcMax}
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
