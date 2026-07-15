export interface EnvironmentReader {
  get(name: string): string | undefined;
}

export function environmentSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnvironmentReader {
  return { get: (name) => env[name] };
}
