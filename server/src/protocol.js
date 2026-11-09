/**
 * OminX Engine — server protocol adapter.
 *
 * The wire format is defined once, in `src/net/Protocol.js`, and shared by browser and server. This
 * module re-exports it and adds the two things only a server needs: id generation and a decoder for
 * client input frames that accepts Node `Buffer`s as well as `ArrayBuffer`s.
 *
 * @module server/src/protocol
 */
export {
  PROTOCOL_VERSION, MessageType, ActorFlags, SNAPSHOT_RATE, INPUT_RATE,
  POSITION_SCALE, ANGLE_SCALE, INPUT_FRAME_BYTES,
  encodeSnapshot, decodeSnapshot, encodeInput, decodeInput, encodeMessage, decodeMessage, actorFlags,
  numericId, formatBytes,
} from '../../src/net/Protocol.js';

import { decodeInput as decodeShared } from '../../src/net/Protocol.js';

/** Short unique id with a readable prefix (`p7f3a91c`). */
export function generateId(prefix = 'id') {
  const random = Math.random().toString(36).slice(2, 9);
  const stamp = (Date.now() % 0xffffff).toString(36);
  return `${prefix}${stamp}${random}`;
}

/** Decodes a client input frame from any binary carrier (Buffer, Uint8Array, ArrayBuffer, DataView). */
export function decodeInputFrame(data) {
  if (data instanceof ArrayBuffer) return decodeShared(data);
  if (ArrayBuffer.isView(data)) {
    return decodeShared(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  throw new TypeError('input frame must be binary');
}

/** Shortest possible delta between two angles, so quantised yaw never spins the long way round. */
export function angleDelta(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export default { generateId, decodeInputFrame, angleDelta };
