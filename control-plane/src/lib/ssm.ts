// SSM Parameter Store, read-only: the cell's host AMI parameter, which the image pipeline writes and
// the launch template resolves at each launch (deploy/lean/Cell/Stack.lean). `GetParameters`, the
// plural action, is the one the control plane's policy allows on that parameter.
import { AwsClient } from "aws4fetch";

export interface Ssm {
  /** The parameter's value, or `null` when it does not exist. */
  parameter(name: string): Promise<{ value: string; modified_ms: number | null } | null>;
}

export class AwsSsm implements Ssm {
  private readonly client: AwsClient;
  private readonly endpoint: string;

  constructor(accessKeyId: string, secretAccessKey: string, region: string) {
    this.client = new AwsClient({ accessKeyId, secretAccessKey, region, service: "ssm" });
    this.endpoint = `https://ssm.${region}.amazonaws.com/`;
  }

  async parameter(name: string): Promise<{ value: string; modified_ms: number | null } | null> {
    const res = await this.client.fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.GetParameters" },
      body: JSON.stringify({ Names: [name] }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`SSM GetParameters failed: ${res.status} ${text.slice(0, 300)}`);
    const r = JSON.parse(text) as { Parameters?: { Name: string; Value: string; LastModifiedDate?: number }[] };
    const p = r.Parameters?.find((x) => x.Name === name);
    return p ? { value: p.Value, modified_ms: p.LastModifiedDate ? Math.round(p.LastModifiedDate * 1000) : null } : null;
  }
}
