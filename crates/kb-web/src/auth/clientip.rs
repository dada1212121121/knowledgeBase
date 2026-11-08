//! 真实客户端 IP(限速、审计、验证码限频都按它算)。
//!
//! 生产上所有请求都经本机的 Node 反向代理进来,TCP 对端永远是 `127.0.0.1`。
//! 如果直接用对端地址,整个站点的人共用一个 IP:一个人输错五次密码,所有人都被锁在门外。
//!
//! 规则(只在**对端是本机回环地址**,也就是确实是我们自己的代理时才信转发头):
//! 1. `CF-Connecting-IP`:Cloudflare 每次都会覆盖它,客户端伪造不了;
//! 2. `X-Forwarded-For` 的**最后一项**:最靠近我们的那一跳加的。**第一项是客户端自己写的**,不能信;
//! 3. 都没有或解析不出来,退回对端地址。
//!
//! 对端不是回环(有人绕过代理直连)时一律用对端地址,转发头当没看见。

use std::net::IpAddr;

use axum::http::HeaderMap;

/// 解析客户端 IP,返回字符串(`unknown` 表示连对端地址都拿不到)。
pub fn resolve(peer: Option<IpAddr>, headers: &HeaderMap) -> String {
    let Some(peer) = peer else {
        return "unknown".to_owned();
    };
    if !peer.is_loopback() {
        return peer.to_string();
    }
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    if let Some(ip) =
        header("cf-connecting-ip").and_then(|value| value.trim().parse::<IpAddr>().ok())
    {
        return ip.to_string();
    }
    if let Some(ip) = header("x-forwarded-for")
        .and_then(|value| value.rsplit(',').next())
        .and_then(|last| last.trim().parse::<IpAddr>().ok())
    {
        return ip.to_string();
    }
    peer.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, value.parse().unwrap());
        }
        map
    }

    fn peer(text: &str) -> Option<IpAddr> {
        Some(text.parse().unwrap())
    }

    #[test]
    fn behind_our_own_proxy_the_cloudflare_header_wins() {
        let h = headers(&[
            ("cf-connecting-ip", "203.0.113.7"),
            ("x-forwarded-for", "1.1.1.1, 198.51.100.9"),
        ]);
        assert_eq!(resolve(peer("127.0.0.1"), &h), "203.0.113.7");
        assert_eq!(resolve(peer("::1"), &h), "203.0.113.7");
    }

    #[test]
    fn without_cloudflare_the_last_forwarded_hop_is_used_not_the_first() {
        // 第一项是客户端自己填的,攻击者可以写任何值来换 IP 躲限速
        let h = headers(&[("x-forwarded-for", "6.6.6.6, 203.0.113.7")]);
        assert_eq!(resolve(peer("127.0.0.1"), &h), "203.0.113.7");
        let single = headers(&[("x-forwarded-for", "203.0.113.8")]);
        assert_eq!(resolve(peer("127.0.0.1"), &single), "203.0.113.8");
    }

    #[test]
    fn garbage_headers_fall_back_to_the_peer() {
        for h in [
            headers(&[("cf-connecting-ip", "not-an-ip")]),
            headers(&[("x-forwarded-for", "evil, <script>")]),
            headers(&[("x-forwarded-for", "")]),
            headers(&[]),
        ] {
            assert_eq!(resolve(peer("127.0.0.1"), &h), "127.0.0.1");
        }
    }

    #[test]
    fn a_direct_non_loopback_peer_cannot_spoof_its_address() {
        let h = headers(&[
            ("cf-connecting-ip", "10.9.8.7"),
            ("x-forwarded-for", "10.9.8.7"),
        ]);
        assert_eq!(
            resolve(peer("198.51.100.20"), &h),
            "198.51.100.20",
            "绕过代理直连时转发头不可信"
        );
        assert_eq!(resolve(None, &h), "unknown");
    }

    #[test]
    fn ipv6_clients_are_normalized() {
        let h = headers(&[(
            "cf-connecting-ip",
            "2001:0DB8:0000:0000:0000:0000:0000:0001",
        )]);
        assert_eq!(resolve(peer("127.0.0.1"), &h), "2001:db8::1");
    }
}
