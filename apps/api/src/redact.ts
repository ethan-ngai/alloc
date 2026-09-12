const MONGO_URI_CREDENTIALS = /(mongodb(?:\+srv)?:\/\/)[^@/\s]*@/gi;

/** Removes credentials embedded in a MongoDB connection string. */
export function redactMongoUri(uri: string): string {
  return uri.replace(MONGO_URI_CREDENTIALS, "$1[redacted]@");
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
