# Normalises ASUSWRT's appGet.cgi?hook=get_clientlist() response into the snapshot body KangOps
# ingests. Kept as a standalone jq file so api/tests/networkParse.test.ts can run it against a
# synthetic fixture -- the shell script around it is just transport.
#
# Input shape (ASUSWRT-Merlin / stock ASUSWRT; NOT yet verified against the live firmware, see
# CLAUDE.md): {"get_clientlist": {"<MAC>": {name, nickName, ip, mac, vendor, isOnline, isGateway,
# ...}, "maclist": [...], "ClientAPILevel": "2"}}. Non-object siblings (maclist, ClientAPILevel)
# are skipped. isOnline arrives as a string "0"/"1" but is tolerated as a number too.
def clean: if . == null then null else (tostring | gsub("^\\s+|\\s+$"; "")) | if . == "" then null else . end end;

{
  collectorVersion: $version,
  devices: [
    (.get_clientlist // {})
    | to_entries[]
    | select(.value | type == "object")
    | .value as $c
    | select(($c.isOnline | tostring) == "1")
    | select(($c.isGateway | tostring) != "1")
    | (($c.mac // .key) | clean) as $mac
    | select($mac != null)
    | {
        mac: ($mac | ascii_upcase),
        ip: ($c.ip | clean),
        # nickName is the name set in the router UI; name is what the device announced.
        hostname: (($c.nickName | clean) // ($c.name | clean)),
        vendor: ($c.vendor | clean)
      }
  ]
}
