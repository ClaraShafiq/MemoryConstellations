// =================================================================
// SSRF 防护：校验外部 endpoint 是否指向内网/元数据地址
// 供 routes/memory-api.js 和 services/llm.js 的所有出站请求共用
// =================================================================

const dns = require('dns');
const net = require('net');

// ── IPv4 判定 ──

// 接受 [a,b,c,d] 或 "a.b.c.d"，返回是否属于私有/保留地址段
function isPrivateIPv4(input) {
    const octets = Array.isArray(input) ? input : input.split('.').map(Number);
    if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
        return true; // 格式异常，安全起见按"私有"处理（fail closed）
    }
    const [a, b, c, d] = octets;
    if (a === 0) return true;                                // 0.0.0.0/8
    if (a === 10) return true;                               // 10.0.0.0/8
    if (a === 127) return true;                              // 127.0.0.0/8 loopback
    if (a === 100 && b >= 64 && b <= 127) return true;        // 100.64.0.0/10 CGNAT
    if (a === 169 && b === 254) return true;                 // 169.254.0.0/16（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true;         // 172.16.0.0/12
    if (a === 192 && b === 0 && c === 0) return true;         // 192.0.0.0/24 IETF Protocol Assignments
    if (a === 192 && b === 0 && c === 2) return true;         // 192.0.2.0/24 TEST-NET-1
    if (a === 192 && b === 168) return true;                  // 192.168.0.0/16
    if (a === 198 && b >= 18 && b <= 19) return true;         // 198.18.0.0/15 benchmarking
    if (a === 198 && b === 51 && c === 100) return true;      // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true;       // 203.0.113.0/24 TEST-NET-3
    if (a >= 224 && a <= 239) return true;                    // 224.0.0.0/4 multicast
    if (a >= 240) return true;                                // 240.0.0.0/4 保留 + 255.255.255.255 广播
    return false;
}

// ── IPv6 判定：展开为 8 个 16bit hextet 后做位运算，不做字符串前缀猜测 ──

// 把 IPv6 地址字符串（无中括号）展开成 8 个 0-65535 整数
function expandIPv6(address) {
    let addr = address;

    // 内嵌 IPv4 尾部（"::ffff:127.0.0.1"）先转成两个合成 hextet，再走统一的 ':' 展开逻辑
    const v4TailMatch = addr.match(/(^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4TailMatch) {
        const octets = v4TailMatch[2].split('.').map(Number);
        if (octets.length === 4 && octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255)) {
            const hextetA = ((octets[0] << 8) | octets[1]).toString(16);
            const hextetB = ((octets[2] << 8) | octets[3]).toString(16);
            addr = addr.slice(0, addr.length - v4TailMatch[2].length) + hextetA + ':' + hextetB;
        }
    }

    let head = addr, tail = '';
    let hasDoubleColon = false;
    if (addr.includes('::')) {
        hasDoubleColon = true;
        const parts = addr.split('::');
        head = parts[0] || '';
        tail = parts[1] || '';
    }

    const headParts = head.length ? head.split(':').filter(p => p !== '') : [];
    const tailParts = tail.length ? tail.split(':').filter(p => p !== '') : [];

    let hextets;
    if (hasDoubleColon) {
        const missing = 8 - (headParts.length + tailParts.length);
        hextets = [...headParts, ...Array(Math.max(missing, 0)).fill('0'), ...tailParts];
    } else {
        hextets = head.split(':').filter(p => p !== '');
    }

    if (hextets.length !== 8) {
        throw new Error('无效的IPv6地址格式'); // 拿不到8段就不认，交给上层 fail closed
    }
    return hextets.map(h => parseInt(h, 16));
}

// 去掉 URL.hostname 可能带的中括号，例如 "[::1]" -> "::1"
function stripBrackets(host) {
    if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
    return host;
}

function isPrivateIPv6(hextets) {
    if (hextets.every(h => h === 0)) return true; // :: 未指定地址
    if (hextets.slice(0, 7).every(h => h === 0) && hextets[7] === 1) return true; // ::1 loopback

    // ::ffff:a.b.c.d IPv4-mapped（RFC 4291）-> 拆出后4字节，按 IPv4 规则递归判定
    if (hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 &&
        hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0xffff) {
        const ipv4 = [
            (hextets[6] >> 8) & 0xff, hextets[6] & 0xff,
            (hextets[7] >> 8) & 0xff, hextets[7] & 0xff
        ];
        return isPrivateIPv4(ipv4);
    }

    // fc00::/7 唯一本地地址：高7位 1111110 -> 掩码0xfe00 应等于0xfc00
    if ((hextets[0] & 0xfe00) === 0xfc00) return true;

    // fe80::/10 链路本地地址：高10位 1111111010 -> 掩码0xffc0 应等于0xfe80
    if ((hextets[0] & 0xffc0) === 0xfe80) return true;

    return false;
}

// ── 统一入口 ──

// 判定一个（已解析出的）IP 地址是否属于私有/内网/保留段
function isPrivateIP(ip) {
    const host = stripBrackets(ip);
    const family = net.isIP(host);
    if (family === 4) return isPrivateIPv4(host);
    if (family === 6) {
        try {
            return isPrivateIPv6(expandIPv6(host));
        } catch (e) {
            return true; // 解析失败 -> fail closed
        }
    }
    return true; // 既不是合法IPv4也不是合法IPv6 -> fail closed
}

// 校验一个外部 endpoint URL 是否可以安全访问：
// - 必须是合法URL、协议必须是 https:
// - 不允许携带用户名/密码
// - hostname 解析出的所有地址都不能是私有/内网/保留地址
// 校验通过则返回 URL 对象，否则 throw Error（中文错误信息）
async function validateEndpoint(endpointString) {
    let url;
    try {
        url = new URL(endpointString);
    } catch (e) {
        throw new Error('无效的endpoint地址');
    }

    if (url.protocol !== 'https:') {
        throw new Error('不允许访问该endpoint地址：仅支持HTTPS');
    }
    if (url.username || url.password) {
        throw new Error('不允许访问该endpoint地址：不支持携带用户名/密码');
    }

    const hostname = stripBrackets(url.hostname.toLowerCase());

    let addresses;
    try {
        addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch (e) {
        throw new Error('无法解析endpoint地址');
    }

    if (!addresses || addresses.length === 0) {
        throw new Error('无法解析endpoint地址');
    }

    for (const { address } of addresses) {
        if (isPrivateIP(address)) {
            throw new Error('不允许访问该endpoint地址');
        }
    }

    return url;
}

// 在已校验的 endpoint 基础上安全拼接路径（避免 new URL(`/x`, base) 把 base 的路径吃掉）。
// 用法: buildSafeUrl(validatedUrl, 'models', `${encodeURIComponent(model)}:generateContent`)
// 各 segment 用 '/' 拼接、且不能以 '/' 开头；动态值调用方自行 encodeURIComponent。
function buildSafeUrl(validatedUrl, ...segments) {
    const base = validatedUrl instanceof URL ? validatedUrl : new URL(validatedUrl);
    const basePath = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
    const baseWithSlash = new URL(basePath, base.origin);
    const relative = segments.join('/');
    return new URL(relative, baseWithSlash);
}

module.exports = {
    isPrivateIP,
    isPrivateIPv4,
    isPrivateIPv6,
    expandIPv6,
    validateEndpoint,
    buildSafeUrl
};
