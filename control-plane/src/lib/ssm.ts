// SSM Parameter Store, read-only: the cell's host AMI parameter, which the image pipeline writes and
// the launch template resolves at each launch (deploy/lean/Cell/Stack.lean). `GetParameters`, the
// plural action, is the one the control plane's policy allows on that parameter.
import { AwsApi, type AwsOptions } from "./aws";

export interface Ssm {
  /** The parameter's value, or `null` when it does not exist. */
  parameter(name: string): Promise<{ value: string; modified_ms: number | null } | null>;
}

export class AwsSsm implements Ssm {
  private readonly api: AwsApi;

  constructor(accessKeyId: string, secretAccessKey: string, region: string, opts?: AwsOptions) {
    this.api = new AwsApi("ssm", accessKeyId, secretAccessKey, region, opts);
  }

  async parameter(name: string): Promise<{ value: string; modified_ms: number | null } | null> {
    const res = await this.api.json("AmazonSSM.GetParameters", { Names: [name] });
    if (!res.ok) throw new Error(`SSM GetParameters failed: ${res.status} ${res.text.slice(0, 300)}`);
    const r = JSON.parse(res.text) as { Parameters?: { Name: string; Value: string; LastModifiedDate?: number }[] };
    const p = r.Parameters?.find((x) => x.Name === name);
    return p ? { value: p.Value, modified_ms: p.LastModifiedDate ? Math.round(p.LastModifiedDate * 1000) : null } : null;
  }
}
