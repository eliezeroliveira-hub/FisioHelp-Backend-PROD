import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUILD_INFO_PATH = fileURLToPath(new URL('../../BUILD_INFO.json', import.meta.url));

export function readBuildInfoSafe() {
  try {
    const parsed = JSON.parse(readFileSync(BUILD_INFO_PATH, 'utf8'));
    return {
      repository: String(parsed?.repository || 'unknown'),
      branch: String(parsed?.branch || 'unknown'),
      commit: String(parsed?.commit || 'unknown'),
      builtAt: String(parsed?.builtAt || 'unknown'),
    };
  } catch {
    return null;
  }
}

export function logBuildInfoSafe() {
  try {
    const buildInfo = readBuildInfoSafe();
    if (buildInfo) {
      console.info('WORKERS_BUILD_INFO', buildInfo);
    } else {
      console.warn('WORKERS_BUILD_INFO indisponível.');
    }
  } catch {
    // O marcador de build nunca pode impedir a inicialização das Functions.
  }
}

export default {
  readBuildInfoSafe,
  logBuildInfoSafe,
};
