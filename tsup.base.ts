import type { Options } from 'tsup'

/**
 * Shared build settings for every package.
 *
 * `composite` and `incremental` are on in tsconfig.base.json so that project
 * references and `tsc --build` work across the workspace, but tsup's
 * declaration builder cannot consume a composite project: it synthesizes its
 * own program, and a composite project demands an explicit file list. Turning
 * both off for the declaration pass only keeps project references working for
 * typechecking while letting tsup emit types.
 */
export const baseConfig: Options = {
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
      declarationMap: false,
    },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: 'es2022',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
}
