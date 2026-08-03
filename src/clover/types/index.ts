export interface CloverTokenResponse {
  access_token: string;
  access_token_expiration: number; // unix seconds
  refresh_token: string;
  refresh_token_expiration: number; // unix seconds
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}
