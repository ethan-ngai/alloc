const MONGO_URI_USERINFO = /(mongodb(?:\+srv)?:\/\/)[^@/\s]*@/gi;
const AWS_SESSION_TOKEN = /(AWS_SESSION_TOKEN(?:\:|%3A))([^,&\s]+)/gi;
const SENSITIVE_QUERY_OPTION = /((?:tlsCertificateKeyFilePassword|proxyUsername|proxyPassword)=)([^&\s]+)/gi;

/** Removes every credential-bearing field supported by MongoDB connection strings. */
export function redactMongoUri(uri: string): string {
  return uri
    .replace(MONGO_URI_USERINFO, "$1[redacted]@")
    .replace(AWS_SESSION_TOKEN, "$1[redacted]")
    .replace(SENSITIVE_QUERY_OPTION, "$1[redacted]");
}

/**
 * Removes connection-string credentials and any supplied secret value from
 * arbitrary text before it reaches a log line or an error message.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let redacted = redactMongoUri(text);
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}
