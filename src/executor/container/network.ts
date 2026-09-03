import { PhaseError } from "../errors.js";
import { commandSpawnShort, shortFailureDetail, type ContainerRuntime, type SpawnShortResult } from "./runtime.js";

/**
 * job 专属网络 + 出站 deny 列表（8.5 容器档的**质变项**）。通道无关：网络的增删走
 * `ContainerRuntime`，deny 规则走 `iptables`。
 *
 * # 为什么要动 iptables
 *
 * 容器档与进程档的区别不是「隔离强度的量级差异」，而是**有没有网络策略**这个质变
 * （边界 15）。而 docker 自己不提供「这个容器不准访问某个网段」这种能力：
 * `--network` 只能选网段，`docker network create --internal` 是「全断外网」的一刀切
 * ——但用户脚本恰恰需要出网（pip install、调被测服务）。要的是「能出网，但打不到
 * 这几个地址」，这在 docker 的模型里没有对应物，只能落到宿主的 netfilter 上。
 *
 * # 具体防的是什么
 *
 * Runner 跑的是**用户仓库里的任意脚本**，而它所在的机器/网络位置是平台的信任区：
 *
 * 1. **云元数据地址 `169.254.169.254`**（服务端 `jobSpec.ts:58` 的默认 deny 项）。
 *    在 EC2 / GCE / 阿里云上，一个 `curl` 就能从这个链路本地地址取到宿主机绑定的
 *    IAM 角色临时凭据，进而以那台机器的身份操作云账号。这是容器逃逸之外最便宜的
 *    一条提权路径——不需要任何漏洞，只需要能发 HTTP。
 * 2. **平台自己的内网段**（部署侧按需追加 `RUNNER_DENY_CIDRS`）。Runner 常被部署在
 *    能连到平台 API / Postgres / Redis 的网络里；不封的话用户脚本可以直接打平台的
 *    内部端点，绕过它自己那份 Token 的权限边界。
 *
 * 这两条都不是「容器隔离」能解决的：容器把文件系统和进程空间隔开了，网络可达性
 * 却是宿主给的。所以规则必须落在宿主上。
 *
 * # 为什么是 DOCKER-USER 链
 *
 * docker 官方指定的用户外挂点：daemon 自己管理 `DOCKER` 链并会在重启/网络变更时
 * 重写它，但**不碰** `DOCKER-USER`，且 `DOCKER-USER` 在 FORWARD 里排在 docker 自己
 * 的规则之前。规则按**入接口**（job 专属网桥 `br-<id 前 12 位>`）匹配，所以只影响
 * 这一个 job 的容器，不动宿主上其它容器。
 *
 * # 为什么是 best-effort 而不是硬失败
 *
 * iptables 不存在（mac 开发机）或没权限（非 root、rootless docker）时记一条 job
 * 日志继续跑。**降级必须被看见**：静默失去网络策略等于把「容器档」卖成一个它
 * 兑现不了的承诺，运维会以为元数据地址已经封了。
 */
export class ContainerNetwork {
  private iptablesRulesInstalled = 0;

  private constructor(
    readonly name: string,
    private readonly bridge: string,
    private readonly denyCidrs: string[],
  ) {}

  static async create(deps: {
    runtime: ContainerRuntime;
    jobId: string;
    denyCidrs: string[];
    log: (line: string) => void;
  }): Promise<ContainerNetwork> {
    const name = `apitrack-net-${deps.jobId.slice(0, 8)}`;
    const created = await deps.runtime.createNetwork(name);
    if (!created.ok) {
      throw new PhaseError("failed", `docker network create failed: ${created.detail}`);
    }
    /* 桥名从网络 Id 推（br-<id 前 12 位>，daemon 的稳定规则）——deny 规则要按入接口名匹配。 */
    const networkId = await deps.runtime.networkId(name);
    const bridge = networkId ? `br-${networkId.slice(0, 12)}` : "";
    const net = new ContainerNetwork(name, bridge, deps.denyCidrs);
    await net.applyDenyRules(deps.log);
    return net;
  }

  /** iptables 永远走宿主进程：Engine API 里没有 netfilter，两条通道在这里是同一份代码。 */
  private static iptables(): (args: string[]) => Promise<SpawnShortResult> {
    return commandSpawnShort("iptables");
  }

  private async applyDenyRules(log: (line: string) => void): Promise<void> {
    if (!this.denyCidrs.length) return;
    if (!this.bridge) {
      log(`container network ${this.name}: bridge name unknown, outbound deny list NOT enforced`);
      return;
    }
    const iptables = ContainerNetwork.iptables();
    let enforced = 0;
    for (const cidr of this.denyCidrs) {
      const result = await iptables(["-I", "DOCKER-USER", "-i", this.bridge, "-d", cidr, "-j", "DROP"]);
      if (result.status === 0) enforced += 1;
      else log(`container network ${this.name}: iptables rule for ${cidr} not installed (${shortFailureDetail(result).slice(0, 160)}); outbound deny NOT enforced for it`);
    }
    this.iptablesRulesInstalled = enforced;
  }

  /** finally 里的清理：deny 规则一条条摘（失败忽略——DOCKER-USER 残留一条 DROP 只影响这台宿主上的既有网桥，可手工摘），网络整删（容器已随 job 收尾）。 */
  async cleanup(deps: { runtime: ContainerRuntime; log: (line: string) => void }): Promise<void> {
    if (this.bridge && this.iptablesRulesInstalled) {
      const iptables = ContainerNetwork.iptables();
      for (const cidr of this.denyCidrs) {
        await iptables(["-D", "DOCKER-USER", "-i", this.bridge, "-d", cidr, "-j", "DROP"]);
      }
    }
    const removed = await deps.runtime.removeNetwork(this.name);
    if (!removed.ok) {
      deps.log(`container network ${this.name} could not be removed (${removed.detail.slice(0, 200)}); it is empty, safe to remove later`);
    }
  }
}
