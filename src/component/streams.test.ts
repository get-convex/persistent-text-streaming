/// <reference types="vite/client" />

import { expect, it } from "vitest";

import schema from "./schema.js";
import { textStreams } from "./streams.js";

it("registers dormant V6 text stream tables in the component schema", () => {
  expect(Object.keys(textStreams.tables()).sort()).toEqual([
    "textStreams",
    "textStreamsEvents",
  ]);
  expect(schema.tables).toMatchObject({
    textStreams: expect.anything(),
    textStreamsEvents: expect.anything(),
  });
});
