import { defineConfig } from 'vite'
import { gccTsBundler } from 'gcc-ts-bundler/vite'

// The official vanilla-ts template ships no vite.config; this adds only the
// gcc-ts-bundler plugin. jQuery is installed the way the jQuery docs recommend
// (`npm install jquery` + `@types/jquery`, `import $ from "jquery"`).
//
// jQuery needs generated externs rather than a framework preset, because it
// builds and reads parts of its own API through strings:
//
//   * `deferred[ tuple[ 0 ] + "With" ] = list.fireWith` constructs
//     `resolveWith`/`rejectWith`/`notifyWith` at runtime, so a dot read of
//     those names must not be renamed (`runtime-aware` finds these);
//   * `jQuery.event.add` writes the handler store as `elemData.events` (a dot
//     write) while `jQuery.event.dispatch` reads it back as
//     `dataPriv.get( this, "events" )` (a string key). Renaming one side and
//     not the other leaves every delegated handler silently unreachable, so
//     the `Data` accessors are declared as key-reading protocol helpers and
//     the scan's `dotDefined ∩ stringLiteralRead` rule turns `events` into a
//     rename barrier.
export default defineConfig({
  preview: { host: true, allowedHosts: true },
  build: { target: 'esnext' },
  plugins: [
    gccTsBundler({
      compiler: { hideWarningsFor: [] },
      externs: {
        generate: {
          mode: 'runtime-aware',
          modules: ['jquery'],
          protocolHelpers: { keyReadCallees: ['access', 'get', 'remove', 'set'] },
        },
      },
    }),
  ],
})
