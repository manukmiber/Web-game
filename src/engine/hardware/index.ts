/**
 * External hardware: boards, channels, and the bindings that connect them to a scene.
 *
 * The transports are *not* here — see `transport.ts` for why the pipe belongs to the host and
 * the interface belongs to the engine.
 */
export * from './protocol';
export * from './transport';
export * from './HardwareDevice';
export * from './HardwareBus';
export * from './bindings';
export * from './HardwareSystem';
