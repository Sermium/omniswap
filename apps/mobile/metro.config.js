// apps/mobile/metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files in the monorepo
config.watchFolders = [monorepoRoot];

// 2. Let Metro know where to resolve packages - important for pnpm
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 3. Force resolving from project node_modules first
config.resolver.disableHierarchicalLookup = false; // Changed to false for pnpm

// 4. Map workspace packages
config.resolver.extraNodeModules = new Proxy(
  {
    '@omniswap/core': path.resolve(monorepoRoot, 'packages/core/src'),
    '@omniswap/types': path.resolve(monorepoRoot, 'packages/types/src'),
    '@omniswap/shared': path.resolve(monorepoRoot, 'packages/shared/src'),
  },
  {
    get: (target, name) => {
      // Called through Object.prototype: a module name that happens to be
      // "hasOwnProperty" would otherwise shadow the method on target.
      if (Object.prototype.hasOwnProperty.call(target, name)) {
        return target[name];
      }
      // Fallback to node_modules
      return path.join(projectRoot, 'node_modules', name);
    },
  }
);

// 5. Handle symlinks from pnpm
config.resolver.unstable_enableSymlinks = true;

// 6. Source extensions
config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];

module.exports = config;
