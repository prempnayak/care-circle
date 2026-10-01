/**
 * Cognito pre-token-generation (V2) trigger: copies email and given_name into the access token,
 * which is what the API (a resource server) receives. Without this, access tokens carry neither.
 */
interface PreTokenEventV2 {
  request: { userAttributes: Record<string, string> };
  response: Record<string, unknown>;
}

export async function handler(event: PreTokenEventV2) {
  const attrs = event.request.userAttributes;
  const claims: Record<string, string> = {};
  if (attrs.email) claims.email = attrs.email;
  if (attrs.given_name) claims.given_name = attrs.given_name;
  event.response = { claimsAndScopeOverrideDetails: { accessTokenGeneration: { claimsToAddOrOverride: claims } } };
  return event;
}
