# Research Basis

Initial research was refreshed on 2026-08-09. MijiaFlow separates facts stated
in public Xiaomi material from independently observed interoperability details.

## Public Xiaomi Material

- Xiaomi's central-gateway support material states that local automation and
  local control operate within the same home and LAN:
  [central gateway function](https://www.mi.com/uk/support/faq/details/KA-527926/).
- Xiaomi's AIoT certification guide documents a Windows client connecting to a
  central gateway over the LAN. It also states that its special test firmware
  omits most consumer functions, including automation:
  [certification quick start](https://autotest.iot.mi.com/acsLanding/%E6%8C%87%E5%8D%97/%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B.html).
- Xiaomi's developer guide describes an RPC channel used by that certification
  client and test firmware:
  [central gateway deep dive](https://autotest.iot.mi.com/acsLanding/%E6%8C%87%E5%8D%97/%E6%B7%B1%E5%85%A5%E4%BA%86%E8%A7%A3%E4%B8%AD%E6%9E%A2%E7%BD%91%E5%85%B3.html).

These sources establish the official local-control context. The public material
located in this review does not specify the consumer Geek Edition web protocol,
`/centrallinkws/`, its ECJPAKE transcript, encrypted frame format, graph RPC
methods, or backup representation.

## Independent Interoperability Work

MijiaFlow's protocol implementation was derived from observable behavior and
metadata of a reachable consumer gateway frontend. No Xiaomi frontend source is
copied or distributed. The first write-compatible profile is deliberately
limited to frontend `v1.6.1` with protocol header `2.0.0`; every other pair is
read-only.

The implementation uses independent TypeScript modules, closed method and
payload allowlists, fixed protocol vectors, a fake gateway, and guarded
transactions. This is an unofficial compatibility target, not an official API
or Xiaomi support commitment.
