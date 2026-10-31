// Host launches and STONITH through the EC2 Query API. Scoped IAM: RunInstances only from the
// cell's two launch templates (sandbox hosts, brain hosts); terminate/stop only instances tagged nest=true.
import { AwsClient } from "aws4fetch";

export type InstanceState = "pending" | "running" | "shutting-down" | "terminated" | "stopping" | "stopped" | "unknown";

/** One RunInstances attempt: the launch template supplies the image, role, network and tags. */
export interface LaunchSpec {
  launchTemplateId: string;
  instanceType: string;
  subnetId: string;
  spot: boolean;
  /** Idempotency token: a retried call never launches a second instance. */
  clientToken: string;
  /**
   * A burstable type's credit mode, given at launch: EC2 drops a launch template's
   * `CreditSpecification` when the template names no instance type, as ours don't.
   */
  cpuCredits?: "standard" | "unlimited";
}

/** EC2 refused for lack of capacity or quota in this pool; another type, zone or market may work. */
export class CapacityError extends Error {}

const CAPACITY_CODES = [
  "InsufficientInstanceCapacity", "InsufficientCapacity", "SpotMaxPriceTooLow", "MaxSpotInstanceCountExceeded",
  "VcpuLimitExceeded", "InstanceLimitExceeded", "Unsupported", "InsufficientFreeAddressesInSubnet",
];

export interface Ec2 {
  /** Launches one instance and returns its id; throws `CapacityError` when this pool can't. */
  launch(spec: LaunchSpec): Promise<string>;
  terminate(instanceId: string): Promise<void>;
  /** `null` when the instance does not exist (already gone). */
  state(instanceId: string): Promise<InstanceState | null>;
  /** The account's own AMIs tagged `nest=true` (the host images), newest first. */
  images(): Promise<ImageInfo[]>;
}

export interface ImageInfo {
  image_id: string;
  name: string;
  created: string;
  state: string;
  size_gib: number | null;
  tags: Record<string, string>;
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
      const code = /<Code>([A-Za-z.]+)<\/Code>/.exec(text)?.[1] ?? "";
      if (CAPACITY_CODES.includes(code)) throw new CapacityError(`EC2 ${params.Action}: ${code}`);
      throw new Error(`EC2 ${params.Action} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return text;
  }

  async launch(spec: LaunchSpec): Promise<string> {
    const xml = await this.call({
      Action: "RunInstances",
      MinCount: "1",
      MaxCount: "1",
      ClientToken: spec.clientToken,
      "LaunchTemplate.LaunchTemplateId": spec.launchTemplateId,
      InstanceType: spec.instanceType,
      SubnetId: spec.subnetId,
      ...(spec.cpuCredits ? { "CreditSpecification.CpuCredits": spec.cpuCredits } : {}),
      ...(spec.spot ? {
        "InstanceMarketOptions.MarketType": "spot",
        "InstanceMarketOptions.SpotOptions.SpotInstanceType": "one-time",
        "InstanceMarketOptions.SpotOptions.InstanceInterruptionBehavior": "terminate",
      } : {}),
    });
    const id = /<instanceId>(i-[0-9a-f]+)<\/instanceId>/.exec(xml)?.[1];
    if (!id) throw new Error(`EC2 RunInstances returned no instance id: ${xml.slice(0, 300)}`);
    return id;
  }

  async terminate(instanceId: string): Promise<void> {
    await this.call({ Action: "TerminateInstances", "InstanceId.1": instanceId });
  }

  async images(): Promise<ImageInfo[]> {
    const xml = await this.call({ Action: "DescribeImages", "Owner.1": "self", "Filter.1.Name": "tag:nest", "Filter.1.Value.1": "true" });
    // One block per image: from its <imageId> to the next. Nested items (block devices, tags) are
    // read inside the block, so the top-level <item> split is never needed.
    const blocks = xml.split("<imageId>").slice(1);
    const field = (b: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(b)?.[1] ?? "";
    return blocks.map((b) => {
      const tags: Record<string, string> = {};
      for (const m of b.matchAll(/<key>([^<]*)<\/key>\s*<value>([^<]*)<\/value>/g)) tags[m[1]!] = m[2]!;
      const size = /<volumeSize>(\d+)<\/volumeSize>/.exec(b)?.[1];
      return {
        image_id: b.slice(0, b.indexOf("</imageId>")), name: field(b, "name"), created: field(b, "creationDate"),
        state: field(b, "imageState"), size_gib: size ? Number(size) : null, tags,
      };
    }).sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  }

  async state(instanceId: string): Promise<InstanceState | null> {
    const xml = await this.call({ Action: "DescribeInstances", "InstanceId.1": instanceId });
    const m = /<instanceState>\s*<code>\d+<\/code>\s*<name>([a-z-]+)<\/name>/.exec(xml);
    return m ? (m[1] as InstanceState) : null;
  }
}
