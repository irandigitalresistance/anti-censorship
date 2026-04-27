export const APP_VERSION = '0.2.0';
export const APP_VERSION_LABEL = 'v0.2';

export type ClientType = 'windows' | 'android';

export interface ClientMetadata {
  clientType: ClientType;
  clientVersion: string;
}
