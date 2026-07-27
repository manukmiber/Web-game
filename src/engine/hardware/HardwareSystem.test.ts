import { beforeEach, describe, expect, it } from 'vitest';
import { createCharacterController } from '../components/CharacterController';
import { createHardwareInput } from '../components/HardwareInput';
import { createHardwareOutput } from '../components/HardwareOutput';
import { CharacterSystem } from '../gameplay/CharacterSystem';
import { Engine } from '../loop/Engine';
import { createTransform, type Component, type Entity } from '../scene/types';
import { HardwareDevice } from './HardwareDevice';
import { HardwareSystem } from './HardwareSystem';
import { LoopbackTransport } from './transport';

const STEP = 1 / 60;

function entityWith(id: string, components: Component[]): Entity {
  return { id, name: id, parentId: null, transform: createTransform(), components };
}

function run(engine: Engine, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) engine.tick(STEP);
}

describe('HardwareSystem', () => {
  let engine: Engine;
  let link: LoopbackTransport;

  beforeEach(async () => {
    engine = new Engine();
    engine.addSystem(new HardwareSystem());
    engine.addSystem(new CharacterSystem());

    link = new LoopbackTransport('uno');
    const device = new HardwareDevice(link, { id: 'uno' });
    engine.hardware.add(device);
    await device.open();
    link.drain();
  });

  it('turns a button into the key the game already reads', () => {
    engine.scene.add(
      entityWith('rig', [createHardwareInput({ bindings: 'D2 -> key:Space', smoothing: 0 })]),
    );
    engine.setMode('play');

    link.receive('D2=1\n');
    engine.tick(STEP);

    expect(engine.input.isDown('Space')).toBe(true);
    // The edge is a real edge: pressed on the frame it arrived, not on every frame after.
    expect(engine.input.wasPressed('Space')).toBe(false); // cleared by endFrame within the tick
  });

  it('walks the character from an analog channel, with no script and no key', () => {
    const player = entityWith('player', [createCharacterController()]);
    engine.scene.add(player);
    engine.scene.add(
      entityWith('rig', [
        createHardwareInput({ bindings: 'A0 -> axis:move bipolar', smoothing: 0 }),
      ]),
    );
    engine.setMode('play');

    // Full forward on a centre-detented stick.
    link.receive('A0=1023\n');
    run(engine, 1);

    expect(player.transform.position[2]).toBeCloseTo(-4, 1);
  });

  it('moves at half speed for half travel — the thing keys cannot do', () => {
    const player = entityWith('player', [createCharacterController()]);
    engine.scene.add(player);
    engine.scene.add(
      entityWith('rig', [
        createHardwareInput({ bindings: 'A0 -> axis:move bipolar', smoothing: 0 }),
      ]),
    );
    engine.setMode('play');

    // Three quarters of travel on a bipolar stick is half forward.
    link.receive('A0=767\n');
    run(engine, 1);

    expect(player.transform.position[2]).toBeCloseTo(-2, 1);
  });

  it('leaves the keyboard working while a rig is plugged in', () => {
    const player = entityWith('player', [createCharacterController()]);
    engine.scene.add(player);
    engine.scene.add(entityWith('rig', [createHardwareInput({ bindings: 'A0 -> axis:move' })]));
    engine.setMode('play');
    engine.input.setKey('KeyW', true);

    run(engine, 1);
    expect(player.transform.position[2]).toBeCloseTo(-4, 1);
  });

  it('zeroes an axis when the binding goes away, rather than latching the last reading', () => {
    const rig = createHardwareInput({ bindings: 'A0 -> axis:move bipolar', smoothing: 0 });
    engine.scene.add(entityWith('rig', [rig]));
    engine.setMode('play');

    link.receive('A0=1023\n');
    engine.tick(STEP);
    expect(engine.input.getAxis('move')).toBeCloseTo(1, 5);

    rig.bindings = '';
    engine.tick(STEP);
    expect(engine.input.getAxis('move')).toBe(0);
  });

  it('smooths a jittering pot without smoothing a button', () => {
    engine.scene.add(
      entityWith('rig', [
        createHardwareInput({ bindings: 'A0 -> axis:move\nD2 -> key:Space', smoothing: 0.5 }),
      ]),
    );
    engine.setMode('play');

    link.receive('A0=1023 D2=1\n');
    engine.tick(STEP);

    // Half way there after one frame, all the way there eventually.
    expect(engine.input.getAxis('move')).toBeCloseTo(0.5, 5);
    expect(engine.input.isDown('Space')).toBe(true);

    engine.tick(STEP);
    expect(engine.input.getAxis('move')).toBeCloseTo(0.75, 5);
  });

  it('drives an output from the entity it is attached to', () => {
    const player = entityWith('player', [
      createCharacterController({ maxHealth: 100 }),
      createHardwareOutput({ bindings: 'D13 <- health01 scale=255 rate=60' }),
    ]);
    engine.scene.add(player);
    engine.setMode('play');

    // Frame one writes zero: hardware runs before the character system, so nothing has
    // registered the player's health yet. One frame of lag on a lamp, and the alternative —
    // splitting outputs into a second system that runs last — costs more than it buys.
    engine.tick(STEP);
    engine.tick(STEP);
    expect(link.drain()).toBe('D13=0\nD13=255\n');

    engine.game.damage('player', 50);
    engine.tick(STEP);
    expect(link.drain()).toBe('D13=128\n');
  });

  it('respects the rate limit rather than writing every frame', () => {
    engine.scene.add(
      entityWith('meter', [
        createHardwareOutput({ bindings: 'D9 <- var:score rate=4' }),
      ]),
    );
    engine.setMode('play');

    let written = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      engine.game.setVar('score', frame);
      engine.tick(STEP);
      written += link.drain() === '' ? 0 : 1;
    }

    // One second at 4 Hz: four or five writes, not sixty.
    expect(written).toBeLessThanOrEqual(5);
    expect(written).toBeGreaterThanOrEqual(4);
  });

  it('leaves the rig dark when the session stops', () => {
    engine.scene.add(
      entityWith('player', [
        createCharacterController(),
        createHardwareOutput({ bindings: 'D13 <- const:255 rate=60' }),
      ]),
    );
    engine.setMode('play');
    engine.tick(STEP);
    expect(link.drain()).toBe('D13=255\n');

    engine.setMode('edit');
    expect(link.drain()).toBe('D13=0\n');
  });

  it('zeroes an output whose binding already names its board', () => {
    // The component supplies a device *and* the line qualifies the channel. Rebuilding the
    // reference from both would produce `uno:uno:D13`, and the lamp would stay lit after Stop.
    engine.scene.add(
      entityWith('rig', [
        createHardwareOutput({ device: 'uno', bindings: 'uno:D13 <- const:200 rate=60' }),
      ]),
    );
    engine.setMode('play');
    engine.tick(STEP);
    expect(link.drain()).toBe('D13=200\n');

    engine.setMode('edit');
    expect(link.drain()).toBe('D13=0\n');
  });

  it('releases a key when the board driving it goes away', () => {
    engine.scene.add(
      entityWith('rig', [createHardwareInput({ bindings: 'D2 -> key:Space', smoothing: 0 })]),
    );
    engine.setMode('play');

    link.receive('D2=1\n');
    engine.tick(STEP);
    expect(engine.input.isDown('Space')).toBe(true);

    // The cable comes out mid-session. A latched key walks the character into the horizon.
    engine.hardware.remove('uno');
    engine.tick(STEP);
    expect(engine.input.isDown('Space')).toBe(false);
  });

  it('releases a key when its binding is deleted mid-session', () => {
    const component = createHardwareInput({ bindings: 'D2 -> key:Space', smoothing: 0 });
    engine.scene.add(entityWith('rig', [component]));
    engine.setMode('play');

    link.receive('D2=1\n');
    engine.tick(STEP);
    expect(engine.input.isDown('Space')).toBe(true);

    component.bindings = '';
    engine.tick(STEP);
    expect(engine.input.isDown('Space')).toBe(false);
  });

  it('reports a bad binding once, not once per frame', () => {
    const problems: string[] = [];
    const system = new HardwareSystem();
    const isolated = new Engine();
    isolated.addSystem(system);
    system.events.on('problem', ({ text }) => problems.push(text));

    isolated.scene.add(entityWith('rig', [createHardwareInput({ bindings: 'A0 => axis:move' })]));
    isolated.setMode('play');
    run(isolated, 0.5);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 1');
  });
});
