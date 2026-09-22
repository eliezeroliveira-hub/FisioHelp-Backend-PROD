import { execFileSync } from 'node:child_process';

function runGit(repositoryRoot, args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function sanitizeRemoteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'unknown';

  if (/^[^@\s]+@[^:]+:.+$/.test(raw)) {
    const [, host, repositoryPath] = raw.match(/^[^@\s]+@([^:]+):(.+)$/) || [];
    if (host && repositoryPath) {
      return `${host}/${repositoryPath.replace(/\.git$/i, '')}`;
    }
  }

  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\.git$/i, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return raw
      .replace(/\/\/[^/@\s]+@/g, '//')
      .replace(/\.git$/i, '');
  }
}

export function assertCleanWorktree(repositoryRoot) {
  const status = runGit(repositoryRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (status) {
    throw new Error(
      'O pacote de workers só pode ser gerado a partir de uma árvore Git limpa.'
    );
  }
}

export function createBuildInfo(repositoryRoot, date = new Date()) {
  const upstream = runGit(repositoryRoot, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  const remoteName = upstream.split('/')[0];
  const remoteUrl = runGit(repositoryRoot, ['remote', 'get-url', remoteName]);

  return {
    repository: sanitizeRemoteUrl(remoteUrl),
    branch: runGit(repositoryRoot, ['branch', '--show-current']) || 'detached',
    upstream,
    commit: runGit(repositoryRoot, ['rev-parse', 'HEAD']),
    builtAt: date.toISOString(),
  };
}

export default {
  sanitizeRemoteUrl,
  assertCleanWorktree,
  createBuildInfo,
};
