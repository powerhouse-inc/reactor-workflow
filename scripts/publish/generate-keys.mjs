// Generates the two identities the release job needs and prints them as the
// three repository secrets. Run once, locally: `node scripts/publish/generate-keys.mjs`.
//
// Nothing is written to disk and nothing is sent anywhere — the keypair is
// generated in memory and the output is the only copy. Paste each value into
// the matching GitHub secret and close the terminal.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NodeKeyStorage, RenownCryptoBuilder } from "@renown/sdk/node";

// viem is a transitive dep of @renown/sdk, so resolve it from the SDK's dir.
const require = createRequire(import.meta.url);
const sdkDir = path.dirname(require.resolve("@renown/sdk/node"));
const { generatePrivateKey, privateKeyToAccount } = await import(
  pathToFileURL(require.resolve("viem/accounts", { paths: [sdkDir] })).href
);

// The builder writes through its storage, so give it a scratch file and read
// the keypair back from there rather than leaving one in the working tree.
const dir = mkdtempSync(path.join(tmpdir(), "rw-keys-"));
const keyPath = path.join(dir, "keypair.json");
let keyPair;
let appDid;
try {
  const crypto = await new RenownCryptoBuilder()
    .withKeyPairStorage(new NodeKeyStorage(keyPath))
    .build();
  appDid = crypto.did;
  // The file wraps the pair under `keyPair`; the env var wants the pair
  // itself, on one line, so it pastes into a secret without reformatting.
  const stored = JSON.parse(readFileSync(keyPath, "utf8"));
  keyPair = JSON.stringify(stored.keyPair ?? stored);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const walletKey = generatePrivateKey();
const account = privateKeyToAccount(walletKey);

console.log(`
This repository's Renown identity is the wallet below. The registry keys
package ownership on its pkh DID, and first publisher wins a name — so once
these pieces are published, this is the only identity that can publish them
again. Keep the wallet key somewhere you can recover it from.

  owner DID   did:pkh:eip155:1:${account.address.toLowerCase()}
  app DID     ${appDid}

Set these three repository secrets (Settings -> Secrets and variables -> Actions):

REGISTRY_WALLET_KEY
${walletKey}

REGISTRY_RENOWN_ADDRESS
${account.address}

REGISTRY_RENOWN_KEY
${keyPair}

Then run the provision-credential workflow once. It signs a delegation from
the wallet to the app DID and stores it in Renown; without it the release job
mints tokens the registry will not accept.
`);
