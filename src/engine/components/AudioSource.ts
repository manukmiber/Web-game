import type { Component } from '../scene/types';
import { registerComponent } from './registry';

/**
 * A sound tied to an entity: a footstep loop, a campfire crackle, an alarm klaxon.
 *
 * `clip` is a URL rather than an asset id — audio has no `AssetStore` entry the way textures do
 * (§8's "textures: user upload + procedural defaults" was never extended to sound, and adding a
 * second asset pipeline for one field is a bigger change than this component needs). It plays
 * from wherever a texture URL already can: a data URL pasted in, or a path the host serves. A
 * proper audio asset browser is future work, the same gap the Materials section of the README
 * already admits for textures.
 *
 * `autoplay` starts the clip the moment Play mode begins, driven by `AudioSystem`. Anything more
 * particular — play on a trigger, play on death, loop while a script decides — goes through the
 * `audio` script API instead; this component is the ambient/embient-object case, not a
 * general-purpose sound trigger.
 */
export interface AudioSourceComponent extends Component {
  type: 'AudioSource';
  enabled: boolean;
  /** A URL — same convention `Material`'s texture slots use. Empty plays nothing. */
  clip: string;
  bus: 'music' | 'sfx' | 'ambient';
  volume: number;
  loop: boolean;
  /** Starts as soon as Play mode begins, without a script asking for it. */
  autoplay: boolean;
  /**
   * Panned and attenuated by distance from the listener (the primary camera) when true. Off by
   * default: a UI blip or a piece of score playing through this component should not go silent
   * because the camera drifted away from wherever the entity happens to sit.
   */
  spatial: boolean;
  /** Metres at which the sound is at full volume. */
  refDistance: number;
  /** Metres beyond which it has faded to nothing. */
  maxDistance: number;
}

export function createAudioSource(overrides: Partial<AudioSourceComponent> = {}): AudioSourceComponent {
  return {
    type: 'AudioSource',
    enabled: true,
    clip: '',
    bus: 'sfx',
    volume: 1,
    loop: false,
    autoplay: false,
    spatial: true,
    refDistance: 1,
    maxDistance: 40,
    ...overrides,
  };
}

registerComponent<AudioSourceComponent>({
  type: 'AudioSource',
  label: 'Audio Source',
  create: createAudioSource,
  fields() {
    return [
      { kind: 'boolean', key: 'enabled', label: 'Enabled' },
      { kind: 'string', key: 'clip', label: 'Clip URL' },
      { kind: 'enum', key: 'bus', label: 'Bus', options: ['music', 'sfx', 'ambient'] },
      { kind: 'number', key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.05 },
      { kind: 'boolean', key: 'loop', label: 'Loop' },
      { kind: 'boolean', key: 'autoplay', label: 'Autoplay' },
      { kind: 'boolean', key: 'spatial', label: 'Spatial' },
      { kind: 'number', key: 'refDistance', label: 'Ref Distance', min: 0, step: 0.5 },
      { kind: 'number', key: 'maxDistance', label: 'Max Distance', min: 0, step: 1 },
    ];
  },
});
