/**
 * The `build.json` a static build serves (#3921, TroubleshootingPictureDesign
 * §4.5 "Builds"): `{ "build": "<tag>" }`, where the tag is the deploy stamp's
 * (`deployStamp.mjs`: 12 hex digits of the commit, `-dirty` when the checkout
 * had uncommitted tracked changes), or `unstamped` when the commit cannot be
 * named. The indexer reads it from the public origin into the build history.
 *
 * It names the commit and nothing else: no time, no path, no environment.
 */
import { deployStamp } from './deployStamp.mjs';

/** The file's body for the checkout at `cwd`. */
export function buildFileBody({ cwd = process.cwd(), env = process.env, git } = {}) {
  const stamp = deployStamp({ cwd, env, git });
  return JSON.stringify({ build: 'tag' in stamp ? stamp.tag : 'unstamped' }) + '\n';
}

/**
 * A Vite plugin that emits `build.json` beside the client bundle. With the
 * Cloudflare plugin's environments it emits only into the client build, the
 * one served as static assets.
 */
export function buildFilePlugin(opts = {}) {
  return {
    name: 'vaipakam-build-file',
    apply: 'build',
    generateBundle() {
      const envName = this.environment?.name;
      if (envName && envName !== 'client') return;
      this.emitFile({ type: 'asset', fileName: 'build.json', source: buildFileBody(opts) });
    },
  };
}
