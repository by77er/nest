import { cloudflareTest } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Three projects:
// - `worker`: the Worker and its Durable Objects, in workerd with the app's bindings (wrangler.jsonc),
//   without the Vite plugin (vite.config.ts). nest is a fake: each test file swaps the global fetch the
//   Worker and its objects call (test/fake-nest.ts), and signs Nest-Identity tokens and webhooks with
//   keys it makes.
//   The GitHub App's key is made for each run (a PKCS#1 PEM, as GitHub hands it out): the Worker signs its
//   JWT with the private half, and the fake GitHub checks it with the public half (TEST_GITHUB_APP_PUBLIC_KEY).
// - `ui`: the page's components (src/ui/), in jsdom with Testing Library, against a stubbed fetch.
// - `node`: the real git and gh, against the sandbox environment the app builds (test-node/).
/** The `RSAPrivateKey` (PKCS#1) inside a PKCS#8 `PrivateKeyInfo`: its last field, an OCTET STRING (RFC 5208). */
function pkcs8ToPkcs1(der: Uint8Array): Uint8Array {
  let at = 0;
  const header = () => {
    const tag = der[at++]!;
    let len = der[at++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + der[at++]!;
    }
    return { tag, len };
  };
  const skip = () => {
    const { len } = header();
    at += len;
  };
  header(); // PrivateKeyInfo SEQUENCE
  skip(); // version
  skip(); // algorithm
  const key = header();
  if (key.tag !== 0x04) throw new Error("not a PKCS#8 RSA key");
  return der.subarray(at, at + key.len);
}
const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...der)).replace(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;
const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const appKey = {
  privateKey: pem("RSA PRIVATE KEY", pkcs8ToPkcs1(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)))),
  publicKey: pem("PUBLIC KEY", new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                NEST_CONTROL_PLANE: "https://nest.test",
                PUBLIC_BASE_URL: "https://projects.test",
                ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
                PROJECTS_AUD: "aud-of-the-projects-application",
                // A client token's shape (nest_cli_<id>_<64 hex>), low in entropy (dev/review-lessons.md 9).
                NEST_CLIENT_TOKEN: `nest_cli_app_${"0".repeat(64)}`,
                NEST_WEBHOOK_SECRET: `whsec_${"1".repeat(64)}`,
                GITHUB_WEBHOOK_SECRET: `ghsec_${"2".repeat(40)}`,
                // The fake GitHub's App (test/fake-nest.ts GH_APP_ID).
                GITHUB_APP_ID: "4242",
                GITHUB_APP_PRIVATE_KEY: appKey.privateKey,
                TEST_GITHUB_APP_PUBLIC_KEY: appKey.publicKey,
              },
            },
          }),
        ],
        test: { name: "worker", include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"], testTimeout: 15_000 },
      },
      {
        plugins: [react()],
        test: { name: "ui", environment: "jsdom", include: ["src/ui/**/*.test.{ts,tsx}"], setupFiles: ["src/ui/test/setup.ts"], testTimeout: 15_000 },
      },
      // `node`: what runs the real git and gh against the environment the app gives a sandbox (test-node/).
      { test: { name: "node", environment: "node", include: ["test-node/**/*.test.ts"], testTimeout: 15_000 } },
    ],
  },
});
