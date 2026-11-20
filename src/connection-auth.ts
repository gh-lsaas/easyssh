export type SessionSecretOptions = {
  auth: string;
  forcePrompt: boolean;
  temporarySecret?: string;
  hasSavedSecret: () => Promise<boolean>;
  prompt: () => Promise<string | null>;
};

// undefined tells Rust to retrieve the stored secret without exposing it to JS.
// null means that the user cancelled; an empty string is valid for an unencrypted key.
export async function resolveSessionSecret(options: SessionSecretOptions): Promise<string | null | undefined> {
  if (options.forcePrompt) return options.prompt();
  if (options.temporarySecret) return options.temporarySecret;
  if (await options.hasSavedSecret()) return undefined;
  if (options.auth === 'key') return undefined;
  return options.prompt();
}
