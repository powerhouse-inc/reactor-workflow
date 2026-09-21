// Mints a short-lived Renown bearer token bound to one registry, for publishing.
// Usage: node scripts/publish/mint-renown-token.mjs <registry-url>
//
// Needs PH_RENOWN_PRIVATE_KEY (the app keypair) and RENOWN_ADDRESS (the
// publisher wallet). A delegation credential for that pair must already exist
// in Renown, or the registry rejects the token — see provision-credential.mjs.
import { NodeKeyStorage, RenownCryptoBuilder } from "@renown/sdk/node";

const registryUrl = process.argv[2];
if (!registryUrl) throw new Error("registry url argument is required");
const address = process.env.RENOWN_ADDRESS;
if (!process.env.PH_RENOWN_PRIVATE_KEY) {
  throw new Error("PH_RENOWN_PRIVATE_KEY is not set");
}
if (!address) throw new Error("RENOWN_ADDRESS is not set");

const crypto = await new RenownCryptoBuilder()
  .withKeyPairStorage(new NodeKeyStorage())
  .build();

// `aud` is what lets the registry tell a token minted for it from one minted
// for another service.
const token = await crypto.getBearerToken(address, {
  aud: registryUrl,
  expiresIn: 600,
});

process.stdout.write(token);
