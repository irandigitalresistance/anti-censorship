export const APP_VERSION = '0.3-beta';
export const APP_VERSION_LABEL = 'v0.3-beta';

export type ClientType = 'windows' | 'android' | 'cli';

export interface ClientMetadata {
  clientType: ClientType;
  clientVersion: string;
}
