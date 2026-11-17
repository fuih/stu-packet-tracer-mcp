import { jsStr } from "./escape.js";
import { withLabel } from "./label.js";

/**
 * DHCP server configuration on Server-PT (NOT on routers — for routers use
 * `pt_apply_services` with CLI). Drives the per-port `DhcpServerProcess`
 * exposed by `Server.getProcess("DhcpServerMainProcess").getDhcpServerProcessByPortName(port)`.
 *
 * API IPC verified against PT 9.0.0.0810 via `scripts/probe-dhcp.ts`:
 *   sp methods: isEnable, setEnable, addPool, addNewPool, getPool, removePool,
 *               getPoolCount, getPoolAt, addExcludedAddress, removeExcludedAddress
 *   pool methods (24 real via Object.getPrototypeOf reflect; NO setTftpAddress):
 *               setNetworkAddress, setNetworkMask, setDefaultRouter,
 *               setStartIp, setEndIp, setDnsServerIp, setMaxUsers,
 *               setNextAvailableIpAddress
 *               + getters incl. getNetworkAddress, getTftpAddress, getWlcAddress
 *
 *   Gotcha: `setNetworkMask` is named that way but actually sets network+mask
 *   together. Real signature `setNetworkMask(network, mask)` (two IP strings), not
 *   `setNetworkMask(mask)`. Passing 1 argument returns "Invalid arguments".
 *   This is in docs/pt-api/classes/DhcpPool.md as `setNetworkMask(ip, ip)`
 *   but the JSON manifest has the wrong signature. Verified at runtime:
 *   `setNetworkMask("172.16.50.0","255.255.255.0")` -> getSubnetMask returns
 *   "255.255.255.0" and getNetworkAddress "172.16.50.0".
 *
 * Confirmed limitations (cannot be patched from JS):
 *   - getTftpAddress() exists but there is NO setter — option-150 on Server-PT
 *     is read-only from the IPC API. To deliver TFTP via DHCP, use the
 *     router as the DHCP server (`pt_apply_services` -> CLI `option 150 ip ...`).
 *   - addNewPool(name, network, mask, gw, dns, maxUsers, startIp, endIp)
 *     returns "Invalid arguments" on PT 9 — documented online signature fails
 *     at runtime, so we must configure slot by slot via setters.
 *   - getDomainName exists but no setter -> domainName cannot be set from JS either (like TFTP).
 */

export interface DhcpExclusion {
  readonly start: string;
  readonly end: string;
}

export interface DhcpPoolSpec {
  readonly name: string;
  readonly network: string;
  readonly subnetMask: string;
  readonly defaultRouter?: string;
  readonly dnsServer?: string;
  readonly startIp?: string;
  readonly endIp?: string;
  readonly maxUsers?: number;
}

export interface ConfigureServerDhcpArgs {
  readonly device: string;
  readonly port?: string;
  readonly enable?: boolean;
  readonly exclusions?: readonly DhcpExclusion[];
  readonly pools?: readonly DhcpPoolSpec[];
  readonly removePools?: readonly string[];
}

const DEFAULT_PORT = "FastEthernet0";

function poolApplyJs(spec: DhcpPoolSpec): string {
  const setters: string[] = [];
  // setNetworkMask in PT 9 is (network, mask) — sets both in a single call.
  setters.push(
    `try{p.setNetworkMask(${jsStr(spec.network)},${jsStr(spec.subnetMask)});}` +
    `catch(e){lines.push("set_netmask_err|"+e);}`,
  );
  if (spec.defaultRouter !== undefined) {
    setters.push(`try{p.setDefaultRouter(${jsStr(spec.defaultRouter)});}catch(e){lines.push("set_router_err|"+e);}`);
  }
  if (spec.dnsServer !== undefined) {
    setters.push(`try{p.setDnsServerIp(${jsStr(spec.dnsServer)});}catch(e){lines.push("set_dns_err|"+e);}`);
  }
  // PT couples maxUsers <-> endIp: setMaxUsers(N) recalculates end = start+N-1
  // and setEndIp(ip) recalculates maxUsers = end-start+1. We apply maxUsers FIRST
  // and endIp AFTERwards so an explicit endIp wins if the user passes both.
  if (spec.startIp !== undefined) {
    setters.push(`try{p.setStartIp(${jsStr(spec.startIp)});}catch(e){lines.push("set_start_err|"+e);}`);
  }
  if (spec.maxUsers !== undefined) {
    setters.push(`try{p.setMaxUsers(${spec.maxUsers});}catch(e){lines.push("set_max_err|"+e);}`);
  }
  if (spec.endIp !== undefined) {
    setters.push(`try{p.setEndIp(${jsStr(spec.endIp)});}catch(e){lines.push("set_end_err|"+e);}`);
  }
  return (
    `(function(){` +
      `var p=null;try{p=sp.getPool(${jsStr(spec.name)});}catch(e){}` +
      `if(!p){try{sp.addPool(${jsStr(spec.name)});}catch(e){lines.push("addPool_err|"+${jsStr(spec.name)}+"|"+e);return;}` +
        `try{p=sp.getPool(${jsStr(spec.name)});}catch(e){}` +
        `if(!p){lines.push("addPool_unreachable|"+${jsStr(spec.name)});return;}` +
        `lines.push("pool_created|"+${jsStr(spec.name)});` +
      `}else{lines.push("pool_existing|"+${jsStr(spec.name)});}` +
      setters.join("") +
      `var rb=[];` +
      `try{rb.push("net="+p.getNetworkAddress());}catch(e){}` +
      `try{rb.push("mask="+p.getSubnetMask());}catch(e){}` +
      `try{rb.push("gw="+p.getDefaultRouter());}catch(e){}` +
      `try{rb.push("dns="+p.getDnsServerIp());}catch(e){}` +
      `try{rb.push("start="+p.getStartIp());}catch(e){}` +
      `try{rb.push("end="+p.getEndIp());}catch(e){}` +
      `try{rb.push("max="+p.getMaxUsers());}catch(e){}` +
      `lines.push("pool_state|"+${jsStr(spec.name)}+"|"+rb.join(","));` +
    `})();`
  );
}

export function configureServerDhcpJs(args: ConfigureServerDhcpArgs): string {
  const port = args.port ?? DEFAULT_PORT;
  const pools = args.pools ?? [];
  const exclusions = args.exclusions ?? [];
  const removePools = args.removePools ?? [];

  const poolApplyCode = pools.map(poolApplyJs).join("");
  const removeCode = removePools.length > 0
    ? removePools.map(n => `try{sp.removePool(${jsStr(n)});lines.push("pool_removed|"+${jsStr(n)});}catch(e){lines.push("pool_remove_err|"+${jsStr(n)}+"|"+e);}`).join("")
    : "";
  const excludeCode = exclusions.length > 0
    ? exclusions.map(ex =>
        `try{sp.addExcludedAddress(${jsStr(ex.start)},${jsStr(ex.end)});lines.push("excl_added|"+${jsStr(ex.start)}+"-"+${jsStr(ex.end)});}catch(e){lines.push("excl_err|"+${jsStr(ex.start)}+"-"+${jsStr(ex.end)}+"|"+e);}`,
      ).join("")
    : "";
  const enableCode = args.enable !== undefined
    ? `try{sp.setEnable(${args.enable ? "true" : "false"});lines.push("enable|"+sp.isEnable());}catch(e){lines.push("enable_err|"+e);}`
    : "";

  const poolNames = pools.map(p => p.name);
  const summary = [
    args.enable !== undefined ? (args.enable ? "enable" : "disable") : null,
    poolNames.length > 0 ? `pools=${poolNames.join(",")}` : null,
    removePools.length > 0 ? `remove=${removePools.join(",")}` : null,
    exclusions.length > 0 ? `excl=${exclusions.length}` : null,
  ].filter(Boolean).join(", ");
  return withLabel(
    `Configuring DHCP on ${args.device}:${port}${summary ? ` (${summary})` : ""}`,
    `(function(){` +
      `var lines=[];` +
      `var d=${'ipc.network()'}.getDevice(${jsStr(args.device)});` +
      `if(!d)return "ERR:device_not_found:"+${jsStr(args.device)};` +
      `var mp=null;try{mp=d.getProcess("DhcpServerMainProcess");}catch(e){return "ERR:no_dhcp_main:"+e;}` +
      `if(!mp)return "ERR:no_dhcp_main:device_not_a_server";` +
      `var sp=null;try{sp=mp.getDhcpServerProcessByPortName(${jsStr(port)});}catch(e){return "ERR:port_lookup:"+e;}` +
      `if(!sp)return "ERR:port_no_dhcp:"+${jsStr(port)};` +
      enableCode +
      removeCode +
      poolApplyCode +
      excludeCode +
      `return lines.join("\\n");` +
    `})()`,
  );
}
