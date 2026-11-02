// The one Node API a UI test uses (theme.test.ts reads the design skill); the app's types are Workers'.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
