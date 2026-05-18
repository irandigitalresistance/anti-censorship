export {
  APP_VERSION,
  APP_VERSION_LABEL,
  type ClientType,
  type ClientMetadata,
} from './version.js';
export {
  CLIENT_CONFIG_PREFIX,
  encodeClientConfig,
  decodeClientConfig,
  type ClientConfigBaleSession,
  type ClientConfigServerPeer,
  type WebTunnelClientConfigV1,
} from './client-config.js';
export { Opcode, type Frame, encodeFrame, decodeFrame, chunkPayload, MAX_CHUNK_PAYLOAD } from './frame.js';
export { encodeOpen, decodeOpen, type OpenAddress } from './open.js';
export {
  MAGIC_REQ,
  MAGIC_OK,
  MAGIC_DENY,
  MAGIC_FRAME,
  MAGIC_FRAME_V2,
  MAGIC_MEET_OFFER,
  buildReq,
  buildOk,
  buildDeny,
  buildFrameMessage,
  buildFrameMessageV2,
  buildMeetOffer,
  parseMagic,
  type MagicMessage,
} from './magic.js';
export {
  deriveKeyFromPassword,
  SessionCipher,
  makeHandshakeReq,
  verifyHandshakeReq,
  makeHandshakeOk,
  verifyHandshakeOk,
  type HandshakeReq,
  type HandshakeOk,
  PSK_SALT_INFO,
} from './handshake.js';
export type { Transport } from './transport.js';
export { TunnelMux, type Stream, type TunnelMuxOptions } from './mux.js';
export { TunnelMuxV2, type TunnelMuxV2Options, type V2Stream, type UdpFlow } from './mux-v2.js';
export { clientHandshake, serverHandshake } from './handshake-flow.js';
export {
  clientHandshakeV2,
  serverHandshakeV2,
  createV2ServerIdentity,
  createV2ServerIdentityFromPrivateKey,
  serverFingerprint,
  type V2ServerIdentity,
  type V2ClientHandshakeResult,
  type V2ServerHandshakeResult,
  type V2ClientMetadata,
} from './handshake-v2.js';
export {
  WT2_VERSION,
  WT2_FLAG_COMPRESSED,
  WT2_FLAG_RELIABLE,
  WT2_DEFAULT_COMPRESSION_THRESHOLD,
  WT2_DEFAULT_MIN_COMPRESSION_SAVINGS,
  encodeV2Packet,
  decodeV2Packet,
  encodeV2ControlMessage,
  decodeV2ControlMessage,
  encodeV2LogReport,
  decodeV2LogReport,
  type V2Packet,
  type DecodedV2Packet,
  type V2PacketType,
  type V2ControlMessage,
  type V2LogReport,
  type EncodeV2PacketOptions,
} from './protocol-v2.js';
export type { ChatType, Peer, IncomingMessage, ISidecar, SidecarMessageListener } from './sidecar.js';
export { MockBalBus, MockSidecar } from './mock-sidecar.js';
export { makeLivekitTransport, type LivekitRoomLike, type LivekitTransportOptions } from './livekit-transport.js';
export { MockLivekitBus, MockLivekitRoom } from './mock-livekit.js';
export {
  makeLocalLivekitRoomFactory,
  startLocalLivekitBroker,
  type LocalLivekitOptions,
  type LocalLivekitBrokerHandle,
} from './local-livekit.js';
export {
  type LivekitRoomFactory,
  type LivekitConnectContext,
  deriveRoomName,
} from './livekit-factory.js';
export {
  BaleClient,
  type BaleClientOptions,
  type BaleSession,
  type AuthError,
  DEFAULT_APP_ID,
  DEFAULT_APP_KEY,
} from './bale/client.js';
export {
  type PhoneAuthResponse,
  type ValidateCodeResponse,
  type UserAuth,
  type StartCallResult,
  type DiscardCallRequest,
  buildLiveKitUrl,
} from './bale/messages.js';
export { GrpcError, parseGrpcWebBody } from './bale/grpc-web.js';
export { NativeBaleSidecar, type NativeSidecarOptions } from './bale/native-sidecar.js';
export { PeerType as BalePeerType, ChatType as BaleChatType } from './bale/messages.js';
export {
  makeBaleMeetFactory,
  connectLivekitRoom,
  isLivekitDataDisabledError,
  LIVEKIT_DATA_DISABLED_CODE,
  type BaleMeetFactoryOptions,
} from './bale/meet-factory.js';
export {
  BaleIncomingCallWatcher,
  decodeIncomingCallEvent,
  type IncomingCallEvent,
  type IncomingCallSource,
  type BaleIncomingCallWatcherOptions,
} from './bale/update-socket.js';
