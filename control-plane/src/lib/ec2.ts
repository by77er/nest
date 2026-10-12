// STONITH through the EC2 Query API. Scoped IAM: terminate/stop only instances tagged nest=true.
import { AwsClient } from "aws4fetch";

export type InstanceState = "pending" | "running" | "shutting-down" | "terminated" | "stopping" | "stopped" | "unknown";

export interface Ec2 {
  terminate(instanceId: string): Promise<void>;
  /** `null` when the instance does not exist (already gone). */
  state(instanceId: string): Promise<InstanceState | null>;
}

/** States in which the instance can no longer run anything. */
export const isDead = (s: InstanceState | null) => s === null || s === "shutting-down" || s === "terminated";

export class AwsEc2 implements Ec2 {
  private readonly client: AwsClient;
  private readonly endpoint: string;

  constructor(accessKeyId: string, secretAccessKey: string, region: string) {
    this.client = new AwsClient({ accessKeyId, secretAccessKey, region, service: "ec2" });
    this.endpoint = `https://ec2.${region}.amazonaws.com/`;
  }

  private async call(params: Record<string, string>): Promise<string> {
    const body = new URLSearchParams({ ...params, Version: "2016-11-15" });
    const res = await this.client.fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      if (text.includes("InvalidInstanceID.NotFound")) return "";
      throw new Error(`EC2 ${params.Action} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return text;
  }

  async terminate(instanceId: string): Promise<void> {
    await this.call({ Action: "TerminateInstances", "InstanceId.1": instanceId });
  }

  async state(instanceId: string): Promise<InstanceState | null> {
    const xml = await this.call({ Action: "DescribeInstances", "InstanceId.1": instanceId });
    const m = /<instanceState>\s*<code>\d+<\/code>\s*<name>([a-z-]+)<\/name>/.exec(xml);
    return m ? (m[1] as InstanceState) : null;
  }
}
