// The pieces this reactor package ships.
import type { PackagePiece } from "@powerhousedao/pieces-framework";

export const pieces: PackagePiece[] = [
  {
    name: "@powerhousedao/piece-convert",
    version: "0.1.0",
    entry: "dist/node/pieces/convert/index.mjs",
  },
];

export default pieces;
