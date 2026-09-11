# Changelog

## Unreleased

- Require Convex 1.39 or newer.
- Use `@convex-dev/stream` for all newly created streams while preserving
  existing stream IDs and persisted text without a migration.
- Keep every existing component, client, and React signature unchanged.
- Add `readStream(ctx, streamId, streamArgs)` and the matching `useStream`
  option. Expose it from an app-owned query so followers subscribe to bounded
  append-only pages instead of re-reading the whole body on every append.
  Authorize that query as you already authorize `getStreamBody`.
- Elect one producer atomically; a duplicate drive request receives `205` and
  reads durably instead of starting a second producer.
- Bound persistence by time and bytes, serialize writes, and publish React text
  at a fixed cadence.
- Recover a failed drive connection through the same durable read, without
  rewinding text already on screen.
- Stop restarting the transport when an auth token rotates mid-stream.
- Cap drive retries so a persistently failing endpoint falls back instead of
  polling indefinitely.
- Retain `getStreamBody` and the React query argument for apps that do not adopt
  `readStream`.

## 0.3.3

- Update ctx types for convex@1.41+

## 0.3.2

- Enables streaming multiple times per hook

## 0.3.1

- Support deleting old streams asynchronously

## 0.3.0

- Adds /test and /\_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API
