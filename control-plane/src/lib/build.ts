// What the deploy stamped into this bundle (dev/deploy-use1.sh, `--define`).

declare const __NEST_CONFIG__: string | undefined;

/**
 * A digest of the deploy's vars (`AWS_CELLS` and the rest). Cloudflare restarts Durable Objects only
 * when a deploy changes code, and a running object keeps the env it started with, so a deploy that
 * changed only vars left FleetDO on the old cell config. Stamping the vars' digest into the code
 * makes every config change a code change. `none` outside a deploy (tests, `wrangler dev`).
 */
export const CONFIG_DIGEST: string = typeof __NEST_CONFIG__ === "string" ? __NEST_CONFIG__ : "none";
