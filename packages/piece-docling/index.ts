// A reactor package's root entry. The pieces themselves are node bundles the
// reactor loads by path, so what a consumer imports from here is the
// declaration of which pieces this package ships.
export { pieces, pieces as default } from "./pieces/index.js";
