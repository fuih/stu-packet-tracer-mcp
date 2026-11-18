import { CABLE_TYPE_ID, DEVICE_TYPE_ID, type CableKind, type DeviceCategory } from "./constants.js";
import { jsStr } from "./escape.js";
import { withLabel, truncateForLabel } from "./label.js";

/**
 * Each public function returns one self-contained JS expression that the
 * Script Engine can execute via `$se('runCode', expr)`. Self-containment is
 * critical: the bridge dispatches commands one at a time, so locals never
 * survive between calls.
 *
 * The returned string is intentionally an expression chain rooted at
 * `ipc.appWindow().getActiveWorkspace().getLogicalWorkspace()` or
 * `ipc.network().getDevice(...)` so the call graph is auditable from the
 * outside without parsing JS.
 */

const LW = "ipc.appWindow().getActiveWorkspace().getLogicalWorkspace()";
const NET = "ipc.network()";

/**
 * Heuristics to label multi-line CLI blocks with a human summary.
 * Recognizes typical patterns pushed by `pt_cook_topology` and `pt_apply_*`
 * (OSPF, EIGRP, BGP, IP, DHCP, VLAN, NAT, ACL...). If no known pattern is
 * found, falls back to the first significant line.
 */
function describeCliBlock(lines: readonly string[]): string {
  if (lines.length === 0) return "(empty)";
  const text = lines.join(" ").toLowerCase();
  const tags: string[] = [];
  const push = (t: string) => { if (!tags.includes(t)) tags.push(t); };

  if (/\brouter ospf\b/.test(text)) push("OSPF");
  if (/\brouter eigrp\b/.test(text)) push("EIGRP");
  if (/\brouter rip\b/.test(text)) push("RIP");
  if (/\brouter bgp\b/.test(text)) push("BGP");
  if (/\bipv6 router ospf\b|\bospfv3\b/.test(text)) push("OSPFv3");
  if (/\bip nat\b/.test(text)) push("NAT");
  if (/\baccess-list\b|\bip access-list\b/.test(text)) push("ACL");
  if (/\bip dhcp pool\b/.test(text)) push("DHCP");
  if (/\bvlan \d+\b/.test(text)) push("VLAN");
  if (/\bswitchport mode trunk\b/.test(text)) push("trunk");
  if (/\bswitchport mode access\b/.test(text)) push("access");
  if (/\bspanning-tree\b/.test(text)) push("STP");
  if (/\binterface vlan\b|\bint vlan\b/.test(text)) push("SVI");
  if (/\bip address\b/.test(text)) push("IP");
  if (/\bipv6 address\b/.test(text)) push("IPv6");
  if (/\bip route\b/.test(text)) push("static route");
  if (/\bipv6 route\b/.test(text)) push("IPv6 route");
  if (/\btelephony-service\b|\bephone\b/.test(text)) push("VoIP");
  if (/\bntp server\b/.test(text)) push("NTP");
  if (/\blogging \d/.test(text)) push("Syslog");
  if (/\bhostname\b/.test(text)) push("hostname");
  if (/\bwrite memory\b|\bcopy run start\b/.test(text)) push("save");

  if (tags.length > 0) return `${tags.join(" + ")} (${lines.length} cmds)`;
  return `${truncateForLabel(lines[0]!, 50)}${lines.length > 1 ? ` (+${lines.length - 1})` : ""}`;
}

export interface AddDeviceArgs {
  readonly name: string;
  readonly category: DeviceCategory;
  readonly model: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Calls `skipBoot()` right after creating the device. PT 9 leaves freshly
 * spawned routers and switches in the "Would you like to enter the initial
 * configuration dialog? [yes/no]" prompt. In that state, calls to
 * `cl.enterCommand("enable")` are discarded because the IOS parser expects
 * "yes"/"no", not commands. Without skipBoot, smoke tests failed with empty
 * `getOutput()` because no commands reached the actual CLI. setPower(true)
 * is defensive: harmless if already powered on, and covers rare models
 * powered off by default.
 */
export function addDeviceJs(args: AddDeviceArgs): string {
  const typeId = DEVICE_TYPE_ID[args.category];
  return withLabel(
    `Creating ${args.category} ${args.name} (${args.model}) at (${args.x},${args.y})`,
    `(function(){` +
      `var lw=${LW};` +
      `var assigned=lw.addDevice(${typeId},${jsStr(args.model)},${args.x},${args.y});` +
      `if(!assigned)return "ERR:addDevice_failed";` +
      `var d=${NET}.getDevice(assigned);` +
      `d.setName(${jsStr(args.name)});` +
      `try{d.setPower(true);}catch(e){}` +
      `try{d.skipBoot();}catch(e){}` +
      `return ${jsStr(args.name)};` +
    `})()`,
  );
}

export interface CreateLinkArgs {
  readonly deviceA: string;
  readonly portA: string;
  readonly deviceB: string;
  readonly portB: string;
  readonly cable: CableKind;
}

export function createLinkJs(args: CreateLinkArgs): string {
  const cableId = CABLE_TYPE_ID[args.cable];
  return withLabel(
    `Cabling ${args.deviceA}:${args.portA} ↔ ${args.deviceB}:${args.portB} (${args.cable})`,
    `(function(){` +
      `var lw=${LW};` +
      `var ok=lw.createLink(${jsStr(args.deviceA)},${jsStr(args.portA)},${jsStr(args.deviceB)},${jsStr(args.portB)},${cableId});` +
      `var a=${NET}.getDevice(${jsStr(args.deviceA)});` +
      `if(!a)return "ERR:first_device_not_found";` +
      `var p=a.getPort(${jsStr(args.portA)});` +
      `if(!p)return "ERR:first_port_not_found";` +
      `var l=null;try{l=p.getLink();}catch(e){}` +
      `if(!l)return "ERR:link_not_created";` +
      `return ok===false?"ERR:createLink_false":"OK";` +
    `})()`,
  );
}

/**
 * Status of both link ends in PT 9. Combines link presence
 * (`port.getLink() !== null`) with native operational status
 * (`isPortUp` / `isProtocolUp`) in a single IPC call.
 *
 * Format: `a:link=<0|1>|port=<0|1>|proto=<0|1>;b:...` or `ERR:<reason>`.
 * `proto=-1` indicates the port does not expose `isProtocolUp` (console /
 * coaxial cables). Cheaper and more reliable than `captureSnapshot()`.
 *
 * To wait for cabling registration after `lw.createLink`, `link=1` on both
 * sides is sufficient. `port`/`proto` only reach `1` once the interface
 * is `no shutdown` and Layer 2/3 has converged.
 */
export function linkUpStatusJs(
  deviceA: string,
  portA: string,
  deviceB: string,
  portB: string,
): string {
  return withLabel(
    `Verifying link ${deviceA}:${portA} ↔ ${deviceB}:${portB}`,
    `(function(){` +
      `function st(d,p){` +
      `var dev=${NET}.getDevice(d);` +
      `if(!dev)return null;` +
      `var port=dev.getPort(p);` +
      `if(!port)return null;` +
      `var lk=0;try{lk=port.getLink()?1:0;}catch(e){lk=0;}` +
      `var pu=0;try{pu=port.isPortUp()?1:0;}catch(e){pu=-1;}` +
      `var prc=0;try{prc=port.isProtocolUp()?1:0;}catch(e){prc=-1;}` +
      `return "link="+lk+"|port="+pu+"|proto="+prc;` +
      `}` +
      `var sa=st(${jsStr(deviceA)},${jsStr(portA)});` +
      `if(sa===null)return "ERR:a_not_found";` +
      `var sb=st(${jsStr(deviceB)},${jsStr(portB)});` +
      `if(sb===null)return "ERR:b_not_found";` +
      `return "a:"+sa+";b:"+sb;` +
    `})()`,
  );
}

/**
 * `LogicalWorkspace.autoConnectDevices(QString, QString)` — PT selects the
 * first available Ethernet on each side and the correct cable (straight for
 * Router↔Switch / PC↔Switch, crossover for Switch↔Switch / Router↔Router).
 *
 * Returns `OK|<portA>|<portB>` with the ports selected by PT, reading
 * the difference between linked ports before and after the call.
 * Useful for recipes that do not require explicit port assignment.
 * For fixed cabling (BGP, NAT, trunks with specific interfaces) use `createLinkJs`.
 */
export function autoConnectDevicesJs(deviceA: string, deviceB: string): string {
  return withLabel(
    `Auto-cabling ${deviceA} ↔ ${deviceB}`,
    `(function(){` +
      `var net=${NET};` +
      `var a=net.getDevice(${jsStr(deviceA)});` +
      `if(!a)return "ERR:a_not_found";` +
      `var b=net.getDevice(${jsStr(deviceB)});` +
      `if(!b)return "ERR:b_not_found";` +
      `function linkedPorts(d){` +
        `var n=d.getPortCount();var hits=[];` +
        `for(var i=0;i<n;i++){var p=d.getPortAt(i);if(!p)continue;` +
        `var lk=null;try{lk=p.getLink();}catch(e){}` +
        `if(lk)hits.push(p.getName());}` +
        `return hits;` +
      `}` +
      `var beforeA=linkedPorts(a);var beforeB=linkedPorts(b);` +
      `try{${LW}.autoConnectDevices(${jsStr(deviceA)},${jsStr(deviceB)});}` +
      `catch(e){return "ERR:"+e;}` +
      `var afterA=linkedPorts(a);var afterB=linkedPorts(b);` +
      `function diff(before,after){var s={};` +
        `for(var i=0;i<before.length;i++)s[before[i]]=1;` +
        `for(var j=0;j<after.length;j++)if(!s[after[j]])return after[j];` +
        `return null;}` +
      `var pA=diff(beforeA,afterA);var pB=diff(beforeB,afterB);` +
      `if(!pA||!pB)return "ERR:no_link_created";` +
      `return "OK|"+pA+"|"+pB;` +
    `})()`,
  );
}

export function removeDeviceJs(name: string): string {
  return withLabel(`Removing device ${name}`, `${LW}.removeDevice(${jsStr(name)})`);
}

export function moveDeviceJs(name: string, x: number, y: number): string {
  return withLabel(
    `Moving ${name} → (${x},${y})`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(name)});` +
      `if(!d)return "ERR:not_found";` +
      `d.moveToLocation(${x},${y});` +
      `return "OK";` +
    `})()`,
  );
}

export function renameDeviceJs(oldName: string, newName: string): string {
  return withLabel(
    `Renaming ${oldName} → ${newName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(oldName)});` +
      `if(!d)return "ERR:not_found";` +
      `if(${NET}.getDevice(${jsStr(newName)}))return "ERR:already_exists";` +
      `d.setName(${jsStr(newName)});` +
      `return "OK";` +
    `})()`,
  );
}

export function deleteLinkJs(deviceName: string, portName: string): string {
  return withLabel(
    `Deleting link on ${deviceName}:${portName}`,
    `${LW}.deleteLink(${jsStr(deviceName)},${jsStr(portName)})`,
  );
}

/**
 * Run a single CLI command on a router or switch and return the delta of
 * `getOutput()` produced by it. Useful when the caller wants raw text back
 * (e.g. `show ip interface brief`).
 *
 * `mode` is kept in signature for compatibility, but PT 9 no longer accepts
 * it: the correct API is `cl.enterCommand(cmd)` with a single argument.
 * Passing two causes `IPC Call ERROR: ConsoleLine - Invalid arguments for
 * IPC call "enterCommand"`.
 */
export function enterCommandJs(deviceName: string, command: string, _mode = ""): string {
  return withLabel(
    `CLI ${deviceName} → ${truncateForLabel(command)}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cl=d.getCommandLine();` +
      `var before=cl.getOutput().length;` +
      `cl.enterCommand(${jsStr(command)});` +
      `return cl.getOutput().substring(before);` +
    `})()`,
  );
}

/**
 * Bulk-feed a CLI block (multi-line string) into a device. Lines are split
 * client-side so each `enterCommand` call gets a single-line payload — the
 * Script Engine balks at embedded newlines when the parser is in some modes.
 *
 * Boot-dialog dismissal: PT 9's `skipBoot()` no longer dismisses the
 * `Would you like to enter the initial configuration dialog? [yes/no]:`
 * prompt, so freshly added routers/switches stall there and every command
 * from the bulk gets fed to the wizard instead of the IOS parser. We
 * silently emit three idempotent lines (empty, "no", empty) before the
 * caller's commands. They clear the dialog if it is showing and are
 * harmless on a device already at `>`/`#`. The `BULK|<count>|...` header
 * still reports only the caller's command count — the dismissal trio is
 * an internal preamble.
 *
 * Reply protocol — first line carries metadata, the rest is the slice of
 * `getOutput()` produced by this batch:
 *   `BULK|<commandsRun>|<truncated>\n<output>`
 *
 * `truncated` is "1" when the output exceeded `tailChars` and was cut to its
 * tail. The caller can therefore decide whether the captured slice is the
 * full transcript or just a tail.
 */
const SAFE_BOOT_DISMISS_JS =
  `var __out=String(cl.getOutput()||"");` +
  `var __tail=__out.substring(Math.max(0,__out.length-350)).replace(/\\s+$/,"");` +
  `var __prompt=typeof cl.getPrompt==="function"?String(cl.getPrompt()||"").replace(/\\s+$/,""):"";` +
  `if(/\\[yes\\/no\\]:?$/i.test(__tail)){` +
    `cl.enterCommand("no");cl.enterCommand("");` +
  `}else if(/Press RETURN to get started!?$/i.test(__tail)||!__prompt){` +
    `cl.enterCommand("");` +
  `}`;

export function bulkCliJs(deviceName: string, cliBlock: string, tailChars = 2000): string {
  const lines = cliBlock.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const userCalls = lines.map(line => `cl.enterCommand(${jsStr(line)})`).join(";");
  return withLabel(
    `Configuring ${deviceName}: ${describeCliBlock(lines)}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cl=d.getCommandLine();` +
      `${SAFE_BOOT_DISMISS_JS}` +
      `var before=cl.getOutput().length;` +
      `${userCalls};` +
      `var full=cl.getOutput().substring(before);` +
      `var truncated="0";` +
      `if(full.length>${tailChars}){full=full.substring(full.length-${tailChars});truncated="1";}` +
      `return "BULK|${lines.length}|"+truncated+"\\n"+full;` +
    `})()`,
  );
}

/**
 * Returns the live state of a device's CommandLine as JSON: `{prompt, tail}`.
 * `tail` are the last 300 chars of the cumulative output buffer; useful to
 * detect the boot dialog (`Would you like to enter the initial configuration
 * dialog? [yes/no]:`) without depending on `getPrompt()` semantics across
 * PT versions.
 *
 * Used by smoke / recipes to wait until a freshly added device is CLI-ready
 * before pumping `bulkCli` at it. Without this gate, commands fly into the
 * void during boot.
 */
export function getCliStateJs(deviceName: string): string {
  return withLabel(
    `Reading active CLI of ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cl=d.getCommandLine();` +
      `var prompt=cl.getPrompt();` +
      `var output=cl.getOutput();` +
      `var tail=output.substring(Math.max(0,output.length-300));` +
      `return JSON.stringify({prompt:String(prompt||""),tail:String(tail||"")});` +
    `})()`,
  );
}

/**
 * Best-effort dismissal of IOS' initial configuration dialog. Sends an empty
 * line, then `no`, then another empty line — the canonical way to skip past
 * `Would you like to enter the initial configuration dialog? [yes/no]:` on
 * routers. `skipBoot()` no longer dismisses it on PT 9.
 */
export function dismissBootDialogJs(deviceName: string): string {
  return withLabel(
    `Dismissing boot dialog on ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cl=d.getCommandLine();` +
      `${SAFE_BOOT_DISMISS_JS}` +
      `return String(cl.getPrompt()||"");` +
    `})()`,
  );
}

/**
 * Inspect a chassis sub-slot. The slot path is a `/`-separated list of
 * `getModuleAt(idx)` steps from `getRootModule()`; the last integer is the
 * bay we want to inspect on the resolved parent module. Same descent shape
 * as `addModuleJs`. Tested patterns (probe-modules-by-pattern.ts, 2026-04-29):
 *   - `"0/1"`: chassis sub-module bay (1941, ISR43xx, PT8200, 2811-WIC, ...)
 *   - `"1"`:   root-direct slot       (2620XM/2621XM NM, 2811-NM)
 *   - `"0"`:   root-direct slot       (Router-PT, Switch-PT)
 *
 * Bays may come pre-populated with `WIC-Cover` stubs from the factory; we
 * treat those as `EMPTY` so the idempotency check in `pt_add_module` doesn't
 * refuse to overwrite a cover.
 *
 *   - `MODULE|<name>`  — bay holds a real module (anything other than WIC-Cover)
 *   - `EMPTY`          — bay is free OR holds a WIC-Cover stub (overwritable)
 *   - `UNKNOWN`        — slot tree didn't let us decide; caller may proceed
 */
export function inspectModuleSlotJs(deviceName: string, slotPath: string): string {
  return withLabel(
    `Inspecting slot ${slotPath} on ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var parts=${jsStr(slotPath)}.split("/");` +
      `if(parts.length<1)return "UNKNOWN";` +
      `var idx=[];for(var i=0;i<parts.length;i++){var n=parseInt(parts[i],10);if(!isFinite(n))return "UNKNOWN";idx.push(n);}` +
      `var bay=idx[idx.length-1];` +
      `var descent=idx.slice(0,idx.length-1);` +
      `var parent=null;try{parent=d.getRootModule();}catch(e){return "UNKNOWN";}` +
      `if(!parent)return "UNKNOWN";` +
      `for(var k=0;k<descent.length;k++){var step=descent[k];try{parent=parent.getModuleAt(step);}catch(e){return "UNKNOWN";}if(!parent)return "UNKNOWN";}` +
      `var bayCount=-1;try{bayCount=Number(parent.getSlotCount());}catch(e){}` +
      `if(bay<0||bay>=bayCount)return "UNKNOWN";` +
      `var sub=null;try{sub=parent.getModuleAt(bay);}catch(e){return "UNKNOWN";}` +
      `if(!sub)return "EMPTY";` +
      `var nm="?";` +
      `try{nm=String(sub.getModuleNameAsString()||"");}catch(e){}` +
      `if(!nm||nm==="None"||nm==="?"){` +
        `try{nm=String(sub.getDescriptor().getModel());}catch(e){}` +
      `}` +
      `if(/^WIC-Cover$/i.test(nm))return "EMPTY";` +
      `return "MODULE|"+nm;` +
    `})()`,
  );
}

export interface EndpointStaticIp {
  readonly device: string;
  readonly port: string;
  readonly ip: string;
  readonly mask: string;
  readonly gateway?: string;
}

export function setEndpointStaticIpJs(args: EndpointStaticIp): string {
  const gwLine = args.gateway
    ? `port.setDefaultGateway(${jsStr(args.gateway)});`
    : "";
  return withLabel(
    `Static IP ${args.ip}/${args.mask} on ${args.device}:${args.port}${args.gateway ? ` (gw ${args.gateway})` : ""}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(args.device)});` +
      `if(!d)return "ERR:not_found";` +
      `d.setDhcpFlag(false);` +
      `var port=d.getPort(${jsStr(args.port)});` +
      `if(!port)return "ERR:port_not_found";` +
      `port.setIpSubnetMask(${jsStr(args.ip)},${jsStr(args.mask)});` +
      gwLine +
      `return "OK";` +
    `})()`,
  );
}

export function setEndpointDhcpJs(deviceName: string): string {
  return withLabel(
    `DHCP on ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var method="setDhcpFlag";` +
      // Enumerate ports and pick the live one. Wireless laptops expose
      // "Wireless0" (or similar), wired PCs expose "FastEthernet0". We
      // prefer the port that is currently linked; if none is linked we
      // fall back to a wireless-named port, then to the first port.
      `var port=null,linked=null,wireless=null,first=null;` +
      `try{` +
        `var n=d.getPortCount();` +
        `for(var i=0;i<n;i++){` +
          `var p=null;try{p=d.getPortAt(i);}catch(e){}` +
          `if(!p)continue;` +
          `if(!first)first=p;` +
          `var iswl=false;try{iswl=!!p.isWirelessPort();}catch(e){}` +
          `if(iswl&&!wireless)wireless=p;` +
          `var lk=null;try{lk=p.getLink();}catch(e){}` +
          `if(lk&&!linked)linked=p;` +
        `}` +
      `}catch(e){}` +
      `port=linked||wireless||first;` +
      `try{` +
        `if(typeof configurePcIp==="function"){` +
          `configurePcIp(${jsStr(deviceName)},true,"","","");` +
          `method="configurePcIp";` +
        `}` +
      `}catch(e){}` +
      `try{d.setDhcpFlag(true);}catch(e){}` +
      `try{if(port&&typeof port.setDhcpClientFlag==="function"){port.setDhcpClientFlag(true);method=method+"+portDhcp("+(port.getName&&port.getName()||"?")+")";}}catch(e){}` +
      `try{d.getCommandLine().enterCommand("ipconfig /renew");method=method+"+renew";}catch(e){}` +
      `return "OK:"+method;` +
    `})()`
  );
}

export interface ConfigureApSsidArgs {
  readonly device: string;
  readonly ssid: string;
  readonly encryptType: number;
  readonly psk?: string;
  readonly standardChannel?: number;
}

export function configureApSsidJs(args: ConfigureApSsidArgs): string {
  return withLabel(
    `Configuring AP ${args.device}: SSID "${args.ssid}" (encrypt=${args.encryptType}${args.standardChannel !== undefined ? `, ch=${args.standardChannel}` : ""})`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(args.device)});` +
      `if(!d)return "ERR:not_found";` +
      `var p=null;` +
      `var names=["WirelessServer","WirelessCommon","Wireless"];` +
      `for(var i=0;i<names.length&&!p;i++){try{p=d.getProcess(names[i]);}catch(e){}}` +
      `if(!p&&typeof d.setSsid==="function")p=d;` +
      `if(!p)return "ERR:wireless_process_not_found";` +
      `try{p.setSsid(${jsStr(args.ssid)});}catch(e){return "ERR:setSsid:"+e;}` +
      `try{if(typeof p.setEncryptType==="function")p.setEncryptType(${args.encryptType});}catch(e){return "ERR:setEncryptType:"+e;}` +
      (args.standardChannel !== undefined
        ? `try{if(typeof p.setStandardChannel==="function")p.setStandardChannel(${args.standardChannel});}catch(e){return "ERR:setStandardChannel:"+e;}`
        : "") +
      (args.psk
        ? `try{var w=p.getWpaProcess&&p.getWpaProcess();if(!w||typeof w.setKey!=="function")return "ERR:wpa_process_not_found";w.setKey(${jsStr(args.psk)});}catch(e){return "ERR:setWpaKey:"+e;}`
        : "") +
      `try{if(typeof p.setSsidBrdCastEnabled==="function")p.setSsidBrdCastEnabled(true);}catch(e){}` +
      `try{if(typeof p.resetAllAssociations==="function")p.resetAllAssociations();}catch(e){}` +
      `var got="";try{got=String(p.getSsid&&p.getSsid()||"");}catch(e){}` +
      `if(got!==${jsStr(args.ssid)})return "ERR:ssid_verify_failed:"+got;` +
      `return "OK:ssid="+got+"|encrypt=${args.encryptType}";` +
    `})()`,
  );
}

export interface AssociateWirelessClientArgs {
  readonly device: string;
  readonly ssid: string;
  readonly encryptType: number;
  readonly psk?: string;
  readonly dhcp?: boolean;
}

export function associateWirelessClientJs(args: AssociateWirelessClientArgs): string {
  // Auth enum heuristic: encryptType==0 (Null/open) → authType=0 (Open),
  // anything else → authType=3 (WPA2-PSK). The PT 9 enum probed in
  // scripts/probe-wireless-associate.ts only exposes authType+encryptType
  // as separate setters (setAuthenType + setEncryptType); without
  // setAuthenType the client stays in "Default" profile and never
  // associates regardless of SSID/key.
  const authType = args.encryptType === 0 ? 0 : 3;
  return withLabel(
    `Associating ${args.device} with SSID "${args.ssid}" (auth=${authType}, encrypt=${args.encryptType}${args.dhcp !== false ? ", DHCP" : ""})`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(args.device)});` +
      `if(!d)return "ERR:not_found";` +
      `var p=null;` +
      `var names=["WirelessClient","WirelessCommon","Wireless"];` +
      `for(var i=0;i<names.length&&!p;i++){try{p=d.getProcess(names[i]);}catch(e){}}` +
      `if(!p&&typeof d.setSsid==="function")p=d;` +
      `if(!p)return "ERR:wireless_process_not_found";` +
      `try{p.setSsid(${jsStr(args.ssid)});}catch(e){return "ERR:setSsid:"+e;}` +
      `try{if(typeof p.setAuthenType==="function")p.setAuthenType(${authType});}catch(e){return "ERR:setAuthenType:"+e;}` +
      `try{if(typeof p.setEncryptType==="function")p.setEncryptType(${args.encryptType});}catch(e){return "ERR:setEncryptType:"+e;}` +
      (args.psk
        ? `try{var w=p.getWpaProcess&&p.getWpaProcess();if(!w||typeof w.setKey!=="function")return "ERR:wpa_process_not_found";w.setKey(${jsStr(args.psk)});}catch(e){return "ERR:setWpaKey:"+e;}`
        : "") +
      `try{if(typeof p.resetAllAssociations==="function")p.resetAllAssociations();}catch(e){}` +
      (args.dhcp !== false
        ? // configurePcIp is the same helper that works for wired PCs in
          // PT 9; calling it on a Laptop-PT correctly drives the wireless
          // port's DHCP state when the client is associated.
          `try{if(typeof configurePcIp==="function")configurePcIp(${jsStr(args.device)},true,"","","");}catch(e){}` +
          `try{d.setDhcpFlag(true);}catch(e){}` +
          // Pick the first wireless-named port (or the linked one) instead
          // of the WirelessClient process's getPort(), which on some PT
          // builds returns null until association completes.
          `try{` +
            `var wp=null,wpLinked=null,wpFirst=null;` +
            `var nn=d.getPortCount&&d.getPortCount()||0;` +
            `for(var k=0;k<nn;k++){` +
              `var pp=null;try{pp=d.getPortAt(k);}catch(e){}` +
              `if(!pp)continue;` +
              `if(!wpFirst)wpFirst=pp;` +
              `var iswl2=false;try{iswl2=!!pp.isWirelessPort();}catch(e){}` +
              `if(iswl2&&!wp)wp=pp;` +
              `var lk2=null;try{lk2=pp.getLink();}catch(e){}` +
              `if(lk2&&!wpLinked)wpLinked=pp;` +
            `}` +
            `var target=wp||wpLinked||wpFirst;` +
            `if(target&&typeof target.setDhcpClientFlag==="function")target.setDhcpClientFlag(true);` +
          `}catch(e){}` +
          `try{d.getCommandLine().enterCommand("ipconfig /renew");}catch(e){}`
        : "") +
      `var got="";try{got=String(p.getSsid&&p.getSsid()||"");}catch(e){}` +
      `if(got!==${jsStr(args.ssid)})return "ERR:ssid_verify_failed:"+got;` +
      `return "OK:ssid="+got+"|encrypt=${args.encryptType}";` +
    `})()`,
  );
}

/**
 * Swaps slot 0 of a Laptop-PT (or compatible host) for the wireless NM,
 * yielding a `Wireless0` port that PT recognises as wireless. Default name
 * `PT-LAPTOP-NM-1W` (2.4GHz). `getSupportedModule()` returns descriptive
 * strings as `<NAME>:<icon><description>` — the bare name before `:` is
 * what `addModule` accepts. Empirically, the only call shape that works is
 * `device.addModule(slotIndexAsString, slotType, bareName)` (verified by
 * `scripts/probe-laptop-modules.ts`); slot path with a leading `/` and the
 * `Module.addModule*` variants all return false.
 *
 * Returns `OK|port=<name>` when at least one wireless port appears post-swap,
 * `ERR:<reason>` otherwise (already-wireless devices short-circuit with OK).
 */
export function swapToWirelessJs(deviceName: string, moduleName = "PT-LAPTOP-NM-1W"): string {
  return withLabel(
    `Switching ${deviceName} to wireless NIC (${moduleName})`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `function findWirelessPort(){` +
        `var nn=d.getPortCount&&d.getPortCount()||0;` +
        `for(var i=0;i<nn;i++){` +
          `var p=null;try{p=d.getPortAt(i);}catch(e){}` +
          `if(!p)continue;` +
          `var iswl=false;try{iswl=!!p.isWirelessPort();}catch(e){}` +
          `if(iswl){var nm="";try{nm=String(p.getName()||"");}catch(e){}return nm||"?";}` +
        `}` +
        `return null;` +
      `}` +
      `var existing=findWirelessPort();` +
      `if(existing)return "OK|port="+existing+"|already";` +
      `var slotType=-1;` +
      `try{slotType=Number(d.getRootModule().getSlotTypeAt(0));}catch(e){return "ERR:slot_type:"+e;}` +
      `try{d.setPower(false);}catch(e){return "ERR:power_off:"+e;}` +
      `try{d.getRootModule().removeModuleAt(0);}catch(e){return "ERR:remove:"+e;}` +
      `var added=false;` +
      `try{added=!!d.addModule("0",slotType,${jsStr(moduleName)});}catch(e){return "ERR:add:"+e;}` +
      `try{d.setPower(true);}catch(e){return "ERR:power_on:"+e;}` +
      `if(!added)return "ERR:add_returned_false|module="+${jsStr(moduleName)}+"|slotType="+slotType;` +
      `var port=findWirelessPort();` +
      `if(!port)return "ERR:no_wireless_port_after_swap";` +
      `return "OK|port="+port;` +
    `})()`,
  );
}

/**
 * Snapshot the current topology as a pipe-separated row per device:
 * `name|model|className|x|y`. The first line is the count.
 * Power Distribution Device is filtered because it's a system object.
 */
export function listDevicesJs(): string {
  return withLabel(
    "Listing canvas devices (name, model, position)",
    `(function(){` +
      `var net=${NET};` +
      `var n=net.getDeviceCount();` +
      `var rows=[];` +
      `for(var i=0;i<n;i++){` +
        `var d=net.getDeviceAt(i);` +
        `var m=d.getModel();` +
        `if(m==="Power Distribution Device")continue;` +
        `rows.push(d.getName()+"|"+m+"|"+d.getClassName()+"|"+d.getXCoordinate()+"|"+d.getYCoordinate());` +
      `}` +
      `return rows.length+"\\n"+rows.join("\\n");` +
    `})()`,
  );
}

/**
 * Live port enumeration for one device, including the IP/mask of each port
 * if it has one assigned. Pipe-separated rows: `portName|ip|mask|connected`.
 */
export function describeDeviceJs(name: string): string {
  return withLabel(
    `Describing device ${name} (ports, IPs, modules)`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(name)});` +
      `if(!d)return "ERR:not_found";` +
      `var rows=[];` +
      `rows.push("MODEL|"+d.getModel());` +
      `rows.push("TYPE|"+d.getType());` +
      `rows.push("POWER|"+d.getPower());` +
      `var pc=d.getPortCount();` +
      `for(var i=0;i<pc;i++){` +
        `var p=d.getPortAt(i);` +
        `var ip="";var mask="";` +
        `try{ip=p.getIpAddress()||"";}catch(e){}` +
        `try{mask=p.getSubnetMask()||"";}catch(e){}` +
        `var lk=p.getLink()?"1":"0";` +
        `rows.push("PORT|"+p.getName()+"|"+ip+"|"+mask+"|"+lk);` +
      `}` +
      `return rows.join("\\n");` +
    `})()`,
  );
}

/**
 * Add a hardware module (NIM-2T, HWIC-2T, NM-2FE2W, PT-ROUTER-NM-1S, ...) to
 * a chassis sub-slot. The slot path encodes a descent through the module
 * tree: each `/`-separated integer is a `getModuleAt(idx)` step from
 * `getRootModule()` down, and the *last* integer is the bay index where
 * `addModuleAt(name, bay)` is called on that parent.
 *
 * PT 9 contract (verified by `scripts/probe-modules-by-pattern.ts` on
 * 2026-04-29 across 7 chassis patterns — see `docs/probe-runs/`):
 *   - `chassis.addModuleAt(string name, int bay)` is the only API that
 *     actually inserts the module. `Device.addModule(...)` returns `false`
 *     uniformly across every model probed.
 *   - The parent module on which to call `addModuleAt` differs per chassis:
 *       * `"0/1"` (1941, 2901, 2911, ISR4321/4331, PT8200, 1841, 2811-WIC):
 *         HWIC/NIM bays live on `root.getModuleAt(0)` (the chassis sub-mod).
 *       * `"1"` (2620XM, 2621XM, 2811-NM): NM goes directly into root slot 1.
 *       * `"0"` (Router-PT-Empty, Switch-PT-Empty): NM-PT slots are direct
 *         children of root.
 *     The common contract is just: descend through `idx[0..n-2]`, then call
 *     `addModuleAt(name, idx[n-1])` on the resolved parent.
 *   - On ISR43xx/PT8200, slot `0/0` is a BUILTIN module (non-overwritable);
 *     the first installable NIM bay is `0/1`.
 *   - WIC-Cover stubs ship factory-installed in every WIC bay of routers that
 *     have them; `addModuleAt` silently overwrites covers. It does NOT
 *     overwrite real modules — once a bay holds an HWIC/NIM/NM, re-calling
 *     `addModuleAt` on the same bay returns `false`. Idempotency is the
 *     caller's job (inspect → skip if already installed).
 *   - Power must be off before the insert; we toggle and `skipBoot()`.
 */
export function addModuleJs(deviceName: string, slotPath: string, model: string): string {
  return withLabel(
    `Installing module ${model} in ${deviceName} slot ${slotPath}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var parts=${jsStr(slotPath)}.split("/");` +
      `if(parts.length<1)return "ERR:bad_slot_path";` +
      `var idx=[];for(var i=0;i<parts.length;i++){var n=parseInt(parts[i],10);if(!isFinite(n))return "ERR:bad_slot_path:"+parts[i];idx.push(n);}` +
      `var bay=idx[idx.length-1];` +
      `var descent=idx.slice(0,idx.length-1);` +
      `var parent=null;try{parent=d.getRootModule();}catch(e){return "ERR:no_root:"+e;}` +
      `if(!parent)return "ERR:no_root";` +
      `for(var k=0;k<descent.length;k++){var step=descent[k];var next=null;try{next=parent.getModuleAt(step);}catch(e){return "ERR:descent_throw|step="+k+"|idx="+step+"|"+e;}if(!next)return "ERR:descent_null|step="+k+"|idx="+step;parent=next;}` +
      `var bayCount=-1;try{bayCount=Number(parent.getSlotCount());}catch(e){}` +
      `if(bay<0||bay>=bayCount)return "ERR:bay_out_of_range|bay="+bay+"|count="+bayCount;` +
      `var wasOn=false;try{wasOn=!!d.getPower();}catch(e){}` +
      `if(wasOn){try{d.setPower(false);}catch(e){return "ERR:power_off:"+e;}}` +
      `var ok=false;` +
      `try{ok=!!parent.addModuleAt(${jsStr(model)},bay);}catch(e){` +
        `if(wasOn){try{d.setPower(true);d.skipBoot();}catch(e2){}}` +
        `return "ERR:addModule_throw:"+e;` +
      `}` +
      `if(wasOn){try{d.setPower(true);d.skipBoot();}catch(e){}}` +
      `return ok?"OK":"ERR:addModule_failed|bay="+bay;` +
    `})()`,
  );
}

/**
 * Walk the hardware factory module catalog and return one row per available
 * module: `model|type|info`. Useful for discovering what modules PT 9.0
 * supports — there are roughly 199 of them in stock 9.0.
 */
export function listModulesJs(): string {
  return withLabel(
    "Listing hardware module catalog (HWIC, NM, WIC)",
    `(function(){` +
      `var mods=ipc.hardwareFactory().modules();` +
      `var n=mods.getAvailableModuleCount();` +
      `var rows=[];` +
      `for(var i=0;i<n;i++){` +
        `var m=mods.getAvailableModuleAt(i);` +
        `var info="";try{info=m.getInfo()||"";}catch(e){}` +
        `rows.push(m.getModel()+"|"+m.getType()+"|"+info.replace(/[\\r\\n|]/g," "));` +
      `}` +
      `return n+"\\n"+rows.join("\\n");` +
    `})()`,
  );
}

/**
 * Persists device running-config to startup-config (NVRAM). Necessary after
 * applying changes via CLI or native API when device might be rebooted during
 * the session (e.g. setPower(false) to install a NIM, PT restarts, etc.).
 *
 * Implementation: reads `cl.getMode()` and only sends `end` if still in
 * config mode (`config*`). Without this gating, `end` sent in privileged
 * EXEC is interpreted by IOS as a hostname for auto-telnet
 * (`Translating "end"...domain server (255.255.255.255)`), blocking the
 * CLI for ~30s while DNS lookup runs. Key lesson in PT 9: NEVER send `end`
 * in privileged EXEC unless `no ip domain-lookup` is configured.
 */
export function saveRunningConfigJs(deviceName: string, tailChars = 200): string {
  return withLabel(
    `Saving running-config of ${deviceName} to NVRAM`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cl=d.getCommandLine();` +
      `var before=cl.getOutput().length;` +
      `var mode="";try{mode=String(cl.getMode()||"");}catch(e){}` +
      `if(/config/i.test(mode))cl.enterCommand("end");` +
      `cl.enterCommand("write memory");` +
      `var out=cl.getOutput().substring(before);` +
      `if(out.length>${tailChars})out=out.substring(out.length-${tailChars});` +
      `return "SAVE|"+out;` +
    `})()`,
  );
}

/**
 * Native L2 access port assignment. Mutates `SwitchPort` directly via
 * `setAccessPort(true)` + `setAccessVlan(id)` — both verified end-to-end
 * in `scripts/probe-switching-native.ts` (VERIFIED §10.3.9b).
 *
 * Returns `OK|<vlanId>` on success (re-reads `getAccessVlan()` to confirm
 * the model accepted the change) or `ERR:<reason>`. Stronger contract than
 * the CLI path, which only fails after IOS prints a parser error.
 */
export function setAccessPortNativeJs(deviceName: string, portName: string, vlanId: number): string {
  return withLabel(
    `Assigning ${deviceName}:${portName} as access VLAN ${vlanId}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:device_not_found";` +
      `var p=d.getPort(${jsStr(portName)});` +
      `if(!p)return "ERR:port_not_found";` +
      `try{` +
        `p.setAccessPort(true);` +
        `p.setAccessVlan(${vlanId});` +
        `var v=p.getAccessVlan();` +
        `if(v!=${vlanId})return "ERR:not_persisted,now="+v;` +
        `return "OK|"+v;` +
      `}catch(e){return "ERR:"+e;}` +
    `})()`,
  );
}

/**
 * Toggle Device.setPower. Verifies via getPower() readback. Idempotent: a
 * device already in the desired state returns "OK|already=<bool>".
 *
 * `skipBoot()` is called after power-on to push router/switch past the
 * initial IOS dialog — without it, calls to `enterCommand("enable")` are
 * silently discarded while the parser waits for "yes/no".
 */
export function setDevicePowerJs(deviceName: string, on: boolean): string {
  return withLabel(
    `${on ? "Powering on" : "Powering off"} ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cur=false;try{cur=!!d.getPower();}catch(e){}` +
      `if(cur===${on ? "true" : "false"})return "OK|already=" + cur;` +
      `try{d.setPower(${on ? "true" : "false"});}catch(e){return "ERR:setPower:"+e;}` +
      (on
        ? `try{d.skipBoot();}catch(e){}`
        : "") +
      `var got=false;try{got=!!d.getPower();}catch(e){}` +
      `return got===${on ? "true" : "false"}?("OK|now="+got):("ERR:not_persisted|now="+got);` +
    `})()`,
  );
}

/**
 * Reads live VLAN database of a switch or router exposing VlanManager via
 * `getProcess`. Iterates through known process names ("Switch",
 * "VlanManager", "MultilayerSwitch") because PT 9 does not standardize the key.
 *
 * Returns pipe-separated rows: `<id>|<name>|<isDefault>|<macCount>` and the
 * count as first line, or `ERR:no_vlan_manager` if not an L2/L3 switch.
 */
export function listVlansJs(deviceName: string): string {
  return withLabel(
    `Reading VLANs from ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var vm=null;` +
      `var names=["Switch","VlanManager","MultilayerSwitch","RoutedSwitch"];` +
      `for(var i=0;i<names.length&&!vm;i++){try{var p=d.getProcess(names[i]);if(p&&typeof p.getVlanCount==="function")vm=p;}catch(e){}}` +
      `if(!vm)return "ERR:no_vlan_manager";` +
      `var n=0;try{n=Number(vm.getVlanCount());}catch(e){return "ERR:getVlanCount:"+e;}` +
      `var rows=[];` +
      `for(var k=0;k<n;k++){` +
        `var v=null;try{v=vm.getVlanAt(k);}catch(e){continue;}` +
        `if(!v)continue;` +
        `var id=0;try{id=Number(v.getVlanNumber());}catch(e){}` +
        `var nm="";try{nm=String(v.getName()||"");}catch(e){}` +
        `var def=false;try{def=!!v.isDefault();}catch(e){}` +
        `var mc=-1;try{var mt=v.getMacTable();if(mt&&typeof mt.getEntryCount==="function")mc=Number(mt.getEntryCount());}catch(e){}` +
        `rows.push(id+"|"+nm.replace(/[\\r\\n|]/g," ")+"|"+(def?"1":"0")+"|"+mc);` +
      `}` +
      `return n+"\\n"+rows.join("\\n");` +
    `})()`,
  );
}

/**
 * Enumerates live state of each Port on a device. Combines link presence,
 * isPortUp, isProtocolUp, MAC, IP/mask and wireless flag — more detailed
 * than `describeDeviceJs` which only reads IP and link.
 *
 * Format per row: `port|link|portUp|protoUp|mac|ip|mask|wireless`.
 * `portUp`/`protoUp` returned as `0|1|-1` (-1 if API unavailable on that port).
 */
export function inspectPortsJs(deviceName: string): string {
  return withLabel(
    `Inspecting ports on ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var n=0;try{n=Number(d.getPortCount());}catch(e){return "ERR:getPortCount:"+e;}` +
      `var rows=[];` +
      `for(var i=0;i<n;i++){` +
        `var p=null;try{p=d.getPortAt(i);}catch(e){continue;}` +
        `if(!p)continue;` +
        `var nm="";try{nm=String(p.getName()||"");}catch(e){}` +
        `var lk=0;try{lk=p.getLink()?1:0;}catch(e){lk=0;}` +
        `var pu=-1;try{pu=p.isPortUp()?1:0;}catch(e){}` +
        `var prc=-1;try{prc=p.isProtocolUp()?1:0;}catch(e){}` +
        `var mac="";try{mac=String(p.getMacAddress()||"");}catch(e){}` +
        `var ip="";try{ip=String(p.getIpAddress()||"");}catch(e){}` +
        `var msk="";try{msk=String(p.getSubnetMask()||"");}catch(e){}` +
        `var wl=0;try{wl=p.isWirelessPort()?1:0;}catch(e){}` +
        `rows.push(nm+"|"+lk+"|"+pu+"|"+prc+"|"+mac+"|"+ip+"|"+msk+"|"+wl);` +
      `}` +
      `return n+"\\n"+rows.join("\\n");` +
    `})()`,
  );
}

/**
 * Reads live AclProcess from a router. Iterates through all Acl objects and
 * returns canonical commands via `getCommandAt` — closest representation to
 * `show running-config | section access-list`, read directly from the model.
 *
 * Format: each ACL preceded by `ACL|<id>|<extended>|<count>`, followed by
 * `  <command>` per statement. First line: total number of ACLs.
 */
export function readAclsJs(deviceName: string): string {
  return withLabel(
    `Reading ACLs from ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var ap=null;` +
      `var names=["AclProcess","Acl"];` +
      `for(var i=0;i<names.length&&!ap;i++){try{var p=d.getProcess(names[i]);if(p&&typeof p.getAclCount==="function")ap=p;}catch(e){}}` +
      `if(!ap)return "ERR:no_acl_process";` +
      `var n=0;try{n=Number(ap.getAclCount());}catch(e){return "ERR:getAclCount:"+e;}` +
      `var lines=[String(n)];` +
      `for(var k=0;k<n;k++){` +
        `var a=null;try{a=ap.getAclAt(k);}catch(e){continue;}` +
        `if(!a)continue;` +
        `var id="";try{id=String(a.getAclId()||"");}catch(e){}` +
        `var ext=false;try{ext=!!a.isExtended();}catch(e){}` +
        `var cc=0;try{cc=Number(a.getCommandCount());}catch(e){}` +
        `lines.push("ACL|"+id+"|"+(ext?"1":"0")+"|"+cc);` +
        `for(var j=0;j<cc;j++){` +
          `var cmd="";try{cmd=String(a.getCommandAt(j)||"");}catch(e){}` +
          `lines.push("  "+cmd.replace(/[\\r\\n]/g," "));` +
        `}` +
      `}` +
      `return lines.join("\\n");` +
    `})()`,
  );
}

/**
 * Walk the live module tree of a device, reporting every populated bay with
 * its slot path (e.g. `0/1`) plus the chassis root descriptor. Used by
 * `pt_list_modules --device` to answer "what's physically installed in this
 * router right now?".
 *
 * BFS-like recursive descent up to depth 3 (PT 9 chassis don't go deeper).
 * Format per row: `<slotPath>|<moduleName>` plus a leading `ROOT|<name>` for
 * the chassis root descriptor.
 */
export function listInstalledModulesJs(deviceName: string): string {
  return withLabel(
    `Listing installed modules on ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var root=null;try{root=d.getRootModule();}catch(e){return "ERR:no_root:"+e;}` +
      `if(!root)return "ERR:no_root";` +
      `var rootName="";` +
      `try{rootName=String(root.getModuleNameAsString()||"");}catch(e){}` +
      `if(!rootName){try{rootName=String(root.getDescriptor().getModel());}catch(e){}}` +
      `var rows=["ROOT|"+rootName];` +
      `function walk(parent,prefix,depth){` +
        `if(depth>3)return;` +
        `var sc=0;try{sc=Number(parent.getSlotCount());}catch(e){return;}` +
        `for(var b=0;b<sc;b++){` +
          `var sub=null;try{sub=parent.getModuleAt(b);}catch(e){continue;}` +
          `if(!sub)continue;` +
          `var nm="";try{nm=String(sub.getModuleNameAsString()||"");}catch(e){}` +
          `if(!nm){try{nm=String(sub.getDescriptor().getModel());}catch(e){}}` +
          `var path=prefix===""?String(b):(prefix+"/"+b);` +
          `rows.push(path+"|"+nm);` +
          `walk(sub,path,depth+1);` +
        `}` +
      `}` +
      `walk(root,"",0);` +
      `return rows.length+"\\n"+rows.join("\\n");` +
    `})()`,
  );
}

/**
 * Returns the logical cluster hierarchy of the workspace.
 *
 * `addCluster()` in PT 9 only operates on the UI selection and there is
 * no IPC to program the selection, so cluster creation is omitted. We can,
 * however, read the existing structure and delete clusters by ID (direct
 * verb `removeCluster`).
 *
 * Format:
 *   - First line: `<count>`
 *   - One row per cluster (including root): `<id>|<name>|<x>|<y>|<parentId>`
 *     where root has `parentId=""`.
 */
export function listClustersJs(): string {
  return withLabel(
    "Listing logical clusters",
    `(function(){` +
      `var lw=${LW};` +
      `var root=null;try{root=lw.getRootCluster();}catch(e){return "ERR:no_root_cluster:"+e;}` +
      `if(!root)return "ERR:no_root_cluster";` +
      `var rows=[];` +
      `function walk(c,parentId){` +
        `if(!c)return;` +
        `var id="";try{id=String(c.getId()||"");}catch(e){}` +
        `var nm="";try{nm=String(c.getName()||"");}catch(e){}` +
        // Root cluster is virtual: getXCoordinate/getYCoordinate dereference
        // a native NULL pointer and crash PT 9 (EXC_BAD_ACCESS, not catchable in JS).
        // We only read coordinates on child clusters.
        `var x=0,y=0;` +
        `if(parentId!==""){` +
          `try{x=Number(c.getXCoordinate());}catch(e){}` +
          `try{y=Number(c.getYCoordinate());}catch(e){}` +
        `}` +
        `rows.push(id+"|"+nm.replace(/[\\r\\n|]/g," ")+"|"+x+"|"+y+"|"+parentId);` +
        `var cc=0;try{cc=Number(c.getChildClusterCount());}catch(e){}` +
        `for(var i=0;i<cc;i++){` +
          `var ch=null;try{ch=c.getChildClusterAt(i);}catch(e){}` +
          `if(ch)walk(ch,id);` +
        `}` +
      `}` +
      `walk(root,"");` +
      `return rows.length+"\\n"+rows.join("\\n");` +
    `})()`,
  );
}

export function removeClusterJs(clusterId: string, keepContents: boolean): string {
  return withLabel(
    `Removing cluster ${clusterId}${keepContents ? " (preserving contents)" : ""}`,
    `(function(){` +
      `var lw=${LW};` +
      `try{lw.removeCluster(${jsStr(clusterId)},${keepContents ? "true" : "false"});}` +
      `catch(e){return "ERR:removeCluster:"+e;}` +
      `var still=null;try{still=lw.getCluster(${jsStr(clusterId)});}catch(e){}` +
      `return still?"ERR:still_present":"OK";` +
    `})()`,
  );
}

export function unClusterJs(clusterId: string): string {
  return withLabel(
    `Unclustering cluster ${clusterId}`,
    `(function(){` +
      `var lw=${LW};` +
      `try{lw.unCluster(${jsStr(clusterId)});}` +
      `catch(e){return "ERR:unCluster:"+e;}` +
      `return "OK";` +
    `})()`,
  );
}

export interface AddNoteArgs {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly fontSize?: number;
}

export function addNoteJs(args: AddNoteArgs): string {
  const fs = args.fontSize ?? 12;
  return withLabel(
    `Adding note at (${args.x},${args.y}): "${truncateForLabel(args.text, 40)}"`,
    `(function(){` +
      `var lw=${LW};` +
      `var uuid="";` +
      `try{uuid=String(lw.addNote(${args.x},${args.y},${fs},${jsStr(args.text)})||"");}` +
      `catch(e){return "ERR:addNote:"+e;}` +
      `if(!uuid)return "ERR:no_uuid";` +
      `return "OK|"+uuid;` +
    `})()`,
  );
}

export interface DrawShapeArgs {
  readonly kind: "line" | "circle";
  readonly a: number; // x or cx
  readonly b: number; // y or cy
  readonly c: number; // x2 or radius
  readonly d?: number; // y2 (line only)
  readonly thickness?: number;
  readonly r?: number;
  readonly g?: number;
  readonly b2?: number;
  readonly alpha?: number;
}

export function drawShapeJs(args: DrawShapeArgs): string {
  const th = args.thickness ?? 2;
  const cr = args.r ?? 0;
  const cg = args.g ?? 0;
  const cb = args.b2 ?? 0;
  const ca = args.alpha ?? 255;
  if (args.kind === "line") {
    const y2 = args.d ?? args.b;
    return withLabel(
      `Drawing line from (${args.a},${args.b}) → (${args.c},${y2})`,
      `(function(){` +
        `var lw=${LW};` +
        `var uuid="";` +
        `try{uuid=String(lw.drawLine(${args.a},${args.b},${args.c},${y2},${th},${cr},${cg},${cb},${ca})||"");}` +
        `catch(e){return "ERR:drawLine:"+e;}` +
        `if(!uuid)return "ERR:no_uuid";` +
        `return "OK|"+uuid;` +
      `})()`,
    );
  }
  return withLabel(
    `Drawing circle at (${args.a},${args.b}) with radius ${args.c}`,
    `(function(){` +
      `var lw=${LW};` +
      `var uuid="";` +
      // drawCircle does not accept thickness, only (x, y, radius, r, g, b, a).
      `try{uuid=String(lw.drawCircle(${args.a},${args.b},${args.c},${cr},${cg},${cb},${ca})||"");}` +
      `catch(e){return "ERR:drawCircle:"+e;}` +
      `if(!uuid)return "ERR:no_uuid";` +
      `return "OK|"+uuid;` +
    `})()`,
  );
}

/**
 * NetworkFile metadata of the currently open .pkt. Calls `getNetworkFile`
 * from `appWindow().getActiveWorkspace()` and reads description + version.
 *
 * Format `key|value` per line: `description|...`, `version|...`,
 * `filename|...`. Keys not present return empty ("description|").
 */
export function readProjectMetadataJs(): string {
  return withLabel(
    "Reading .pkt project metadata",
    `(function(){` +
      // Correct access is appWindow().getActiveFile(); getActiveWorkspace()
      // does not expose NetworkFile in PT 9.0.0.0810.
      `var aw=null;try{aw=ipc.appWindow();}catch(e){return "ERR:no_app_window:"+e;}` +
      `if(!aw)return "ERR:no_app_window";` +
      `var nf=null;try{nf=aw.getActiveFile();}catch(e){return "ERR:getActiveFile:"+e;}` +
      `if(!nf)return "ERR:no_network_file";` +
      `var rows=[];` +
      `var desc="";try{desc=String(nf.getNetworkDescription()||"");}catch(e){}` +
      `var ver="";try{ver=String(nf.getVersion()||"");}catch(e){}` +
      `var fn="";try{fn=String(nf.getSavedFilename()||"");}catch(e){}` +
      `rows.push("description|"+desc.replace(/[\\r\\n]/g," "));` +
      `rows.push("version|"+ver);` +
      `rows.push("filename|"+fn);` +
      `return rows.join("\\n");` +
    `})()`,
  );
}

export const ipcRoots = { LW, NET } as const;
