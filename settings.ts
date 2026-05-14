import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.ts';

export interface StoredSettings {
  refreshToken: string;
}

export async function readSettings(): Promise<StoredSettings> {
  try {
    const contents = await readFile(config.storedSettingsFile, 'utf8');
    return parseSettings(contents);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { refreshToken: '' };
    }

    throw error;
  }
}

export async function storeSettings(settings: StoredSettings): Promise<void> {
  await mkdir(dirname(config.storedSettingsFile), { recursive: true });

  const tempPath = `${config.storedSettingsFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tempPath, config.storedSettingsFile);
}

function parseSettings(contents: string): StoredSettings {
  const data = JSON.parse(contents) as Partial<StoredSettings>;

  if (typeof data.refreshToken !== 'string') {
    throw new Error(`Invalid settings file format`);
  }

  return {
    refreshToken: data.refreshToken,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
