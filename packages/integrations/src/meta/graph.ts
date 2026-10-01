/**
 * Graph API version, matching Meta's published OpenAPI spec (facebook/openapi,
 * business-messaging-api_v23.0.yaml). Bump deliberately after reading the changelog.
 */
export const GRAPH_VERSION = 'v23.0';
export const GRAPH_BASE_URL = 'https://graph.facebook.com';

export type Fetch = typeof globalThis.fetch;
