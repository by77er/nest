// What a rule constructor (lib/rules/*.ts) adds to a sandbox's egress policy: the same generic shapes an
// operator writes by hand in the sandbox layer (docs/sandbox/networking/egress/policy/#request-guards).
import type { InjectionBinding, RequestGuard } from "../../protocol/model";

export interface PolicyFragment {
  allow: { host: string; ports?: number[] }[];
  inject: InjectionBinding[];
  guards: RequestGuard[];
}
