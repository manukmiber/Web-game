import { useEffect, useState } from 'react';
import { AUDIO_BUSES, type AudioBus, type AudioSnapshot } from '@engine/audio/AudioEngine';
import type { AudioSourceComponent } from '@engine/components/AudioSource';
import { useEditor } from '../EditorContext';
import { useEditorStore } from '../state/editorStore';
import { Group, Row, Slider } from './controls';

/** Twice a second. A voice count that lags by half a second still reads as live. */
const REFRESH_MS = 500;

const BUS_NOTES: Record<AudioBus, string> = {
  music: 'The score. One slot — starting a track replaces whatever was on it.',
  sfx: 'One-shots: footsteps, impacts, UI. Where a sound goes unless it says otherwise.',
  ambient: 'Beds and loops — wind, a generator, a room tone.',
};

const STATE_NOTES: Record<AudioSnapshot['state'], string> = {
  idle: 'No audio context yet — the first sound to play will create one.',
  running: 'Running.',
  suspended: 'Suspended by the browser until a gesture reaches the page.',
  closed: 'Closed.',
  unavailable: 'This browser has no Web Audio, so nothing here will make a sound.',
};

/**
 * The mixer.
 *
 * Everything below has existed since v0.7.7 and, until now, could only be reached from a script:
 * `audio.setBusVolume('music', 0.4)` was the only way to turn the music down, which makes a
 * mixing decision — the most iterative kind there is — into an edit-compile-play loop. A fader
 * you can drag while the scene is running is not a nicer way to do the same thing; it is the
 * only way anyone actually balances audio.
 *
 * Deliberately *not* persisted, unlike the graphics settings. A bus level is a property of the
 * game being built — how loud the score should sit under the effects — not of the machine it is
 * being built on, so it belongs in a scene one day and in nobody's `localStorage` today. What it
 * does instead is survive nothing: `Engine.setMode` stops every voice on a mode change, and the
 * levels stay where they were put, which is the behaviour you want while iterating.
 *
 * The readouts are here for the same reason the Hardware panel shows raw channel values: when
 * there is no sound, the useful question is never "is the volume up" but "is anything playing at
 * all, and did the file load". `state` answers the third thing that goes wrong, which is a
 * browser holding the context suspended until someone clicks — a failure that looks exactly like
 * a bug in the engine and is not.
 */
export function AudioPanel() {
  const { engine } = useEditor();
  const playing = useEditorStore((s) => s.playing);
  const sceneRevision = useEditorStore((s) => s.sceneRevision);
  const setSelection = useEditorStore((s) => s.setSelection);
  const [snapshot, setSnapshot] = useState<AudioSnapshot>(() => engine.audio.snapshot());

  useEffect(() => {
    const sample = () => setSnapshot(engine.audio.snapshot());
    sample();
    const timer = setInterval(sample, REFRESH_MS);
    return () => clearInterval(timer);
  }, [engine]);

  // Re-read on every structural change so adding an AudioSource shows up without a play session.
  void sceneRevision;
  const sources = engine.ecs
    .with('AudioSource')
    .map((entity) => ({
      entity,
      source: entity.components.find(
        (c): c is AudioSourceComponent => c.type === 'AudioSource',
      )!,
    }));

  /**
   * The faders write straight through to the engine and then re-read it.
   *
   * `setSnapshot(engine.audio.snapshot())` rather than storing the slider's own value: the engine
   * is the only place a level lives, a script can move one mid-drag, and a control that keeps a
   * private copy is a control that will eventually disagree with what you are hearing.
   */
  const apply = (change: () => void) => {
    change();
    setSnapshot(engine.audio.snapshot());
  };

  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <div className="panel-content">
      <div className="panel-bar">
        <span className="panel-bar-note">
          Levels apply immediately and are not saved — a mix belongs to the game, not to this
          browser.
        </span>
        {snapshot.state === 'suspended' && (
          <button
            onClick={() => void engine.audio.resume().then(() => apply(() => {}))}
            title="Browsers hold a new audio context suspended until a gesture reaches the page"
          >
            Unlock audio
          </button>
        )}
        <button
          onClick={() => apply(() => engine.audio.stopAll())}
          disabled={snapshot.voices === 0}
          title="Drop every playing and pending voice, the way pressing Stop does"
        >
          Stop all
        </button>
      </div>

      <div className="panel-scroll panel-columns">
        <Group title="Master">
          <Slider
            label="Volume"
            value={snapshot.masterVolume}
            min={0}
            max={1}
            step={0.01}
            format={percent}
            onChange={(value) => apply(() => engine.audio.setMasterVolume(value))}
          />
          <Row label="Mute">
            <input
              type="checkbox"
              checked={snapshot.muted}
              onChange={(event) => apply(() => engine.audio.setMuted(event.currentTarget.checked))}
            />
          </Row>
          <p className="note">
            Mute is a switch above the faders rather than a fourth one on them, so silencing
            everything and then unmuting brings back the exact balance you left — see the note on{' '}
            <code>AudioBus</code>.
          </p>
        </Group>

        <Group title="Buses">
          {AUDIO_BUSES.map((bus) => (
            <Slider
              key={bus}
              label={bus[0]!.toUpperCase() + bus.slice(1)}
              value={snapshot.busVolumes[bus]}
              min={0}
              max={1}
              step={0.01}
              format={percent}
              onChange={(value) => apply(() => engine.audio.setBusVolume(bus, value))}
            />
          ))}
          <p className="note">
            {AUDIO_BUSES.map((bus) => (
              <span key={bus} className="bus-note">
                <strong>{bus}</strong> — {BUS_NOTES[bus]}
              </span>
            ))}
          </p>
        </Group>

        <Group title="Engine">
          <Row label="Context">
            <span className={`audio-state ${snapshot.state}`}>{snapshot.state}</span>
          </Row>
          <Row label="Voices">
            <span className="control-value">{snapshot.voices}</span>
          </Row>
          <Row label="Music">
            <span className="control-value">{snapshot.musicPlaying ? 'playing' : '—'}</span>
          </Row>
          <Row label="Clips">
            <span className="control-value">
              {snapshot.clipsLoaded}
              {snapshot.clipsLoading > 0 && ` (+${snapshot.clipsLoading} loading)`}
            </span>
          </Row>
          <p className="note">{STATE_NOTES[snapshot.state]}</p>
        </Group>

        <Group title={`Sources in the scene — ${sources.length}`}>
          {sources.length === 0 ? (
            <p className="note">
              Nothing in the scene has an Audio Source. Add one from the Inspector to give an
              entity a sound of its own; scripts can play through <code>audio.play</code> without.
            </p>
          ) : (
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Bus</th>
                  <th className="numeric">Vol</th>
                  <th>Clip</th>
                </tr>
              </thead>
              <tbody>
                {/*
                  Rows select their entity, the same gesture the Statistics table's heaviest list
                  uses. "Which of these is the one that is too loud" and "take me to it" are one
                  question, and a table that answers only the first sends you back to the
                  Hierarchy to search by name.
                */}
                {sources.map(({ entity, source }) => (
                  <tr
                    key={entity.id}
                    className={source.enabled ? '' : 'disabled'}
                    onClick={() => setSelection([entity.id])}
                    title={source.enabled ? 'Select this entity' : 'Disabled — plays nothing'}
                  >
                    <td>
                      {source.autoplay ? '▶ ' : ''}
                      {entity.name}
                    </td>
                    <td>{source.bus}</td>
                    <td className="numeric">{percent(source.volume)}</td>
                    <td className="clip-cell" title={source.clip || 'No clip set'}>
                      {source.clip ? clipName(source.clip) : <em>none</em>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!playing && sources.some((s) => s.source.autoplay) && (
            <p className="note">Autoplay sources start when you press Play.</p>
          )}
        </Group>
      </div>
    </div>
  );
}

/**
 * The tail of a clip URL.
 *
 * A data URL is thousands of characters of base64 and a served path is often deeply nested;
 * either one printed in full turns the table into a horizontal scrollbar. The full value is on
 * the cell's `title`, which is where a URL you actually want to read belongs.
 */
function clipName(clip: string): string {
  if (clip.startsWith('data:')) return `data:… (${Math.round(clip.length / 1024)} kB)`;
  const tail = clip.split(/[?#]/)[0]!.split('/').pop();
  return tail && tail.length > 0 ? tail : clip;
}
