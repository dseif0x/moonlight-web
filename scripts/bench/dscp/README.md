# DSCP and Wi-Fi WMM — the bench's probes

Plan « le son et la priorité des paquets (DSCP/WMM) », piste 2, phase D0:
prove what a packet's DSCP becomes on the wire and on the air before any
product code marks anything. Findings go to
`docs/design/network-latency-findings.md`.

## Tools

| File | Where | What |
|---|---|---|
| `win_dscp_probe.py` | Windows sender | tries each way a process can mark (plain, `IP_TOS`, `WSASendMsg` with an `IP_TOS` control message per packet, qWAVE traffic type, qWAVE exact value), each with its own payload size |
| `tosparse.py` | Linux receiver | DSCP per payload size in a `tcpdump -n -v -l` text capture |
| `udptos.py` | Linux sender | marked UDP, one class at a time (DF, CS1, AF11, AF41, CS5, VA, EF, CS6, CS7), each with its own size and time window; prints the windows |
| `mon-on.sh`, `mon-off.sh`, `mon-cap.sh` | Linux, Intel AX210 | monitor mode on channel 44 / 80 MHz (the Freebox's 5 GHz), back to managed, a capture of N seconds |
| `tidstat.py` | Linux | per receiver and transmitter, the 802.11 QoS data frames by TID (bad-FCS frames left out) |
| `tidtime.py` | Linux | the TIDs of the frames to one station from one source, per `udptos.py` window: the access point's DSCP → Wi-Fi queue table |

TID → queue: 1-2 BK, 0 and 3 BE, 4-5 VI, 6-7 VO.

### Windows marking probe

```
# receiver (Linux, wired): what arrives
sudo tcpdump -n -v -l -i enp2s0 udp port 9 and src <windows-ip> > probe.txt
# sender (Windows)
python win_dscp_probe.py <linux-ip> 46 20 9
# then
python3 tosparse.py probe.txt
```

### The access point's table, on the air

```
./mon-on.sh                      # AX210 in monitor mode, channel 44 / 80 MHz
./mon-cap.sh 60 /tmp/mon.pcap &  # capture while the classes go out
python3 udptos.py <wifi-station-ip> 100 5 2 > windows.txt   # from a wired host
python3 tidtime.py /tmp/mon.pcap <station-mac> <wired-host-mac> windows.txt
./mon-off.sh                     # back to managed, handed to NetworkManager
```

The station needs no listener: the access point sends the frames anyway. The
802.11 header (and its QoS field) is not encrypted, only the payload. A far
access point decodes poorly: most frames come with a bad FCS and are left out.

## Readings

### 05/10/2026 — D0, first readings (session moonlight-web-da)

**The Freebox's WMM parameters** (`iw dev wlp3s0 scan` on the UM790Pro): the
box and every repeater (SSID `OctoPowerWifi7`, 5 GHz channel 44 at 80 MHz,
2.4 GHz channel 6) advertise the standard client parameters, no admission
control: VO CW 3-7 AIFSN 2 TXOP 1504 µs; VI CW 7-15 AIFSN 2 TXOP 3008 µs; BE CW
15-1023 AIFSN 3; BK CW 15-1023 AIFSN 7. No 6 GHz BSS seen.

**On the air, passive** (UM790Pro's AX210 in monitor mode, during the Wi-Fi
plan's W4 series): the N95 (`78:8a:86:09:57:5c`) sits on the far repeater
(`3a:07:16:ec:68:b4`, -68 dBm from the UM790Pro). The stream from DualRTX
(Windows native host, DSCP 0) reaches it in TID 0 (best effort): 146 of 146
decodable frames. A household iPhone on the same repeater sends and receives
in TID 6 (voice).

**Windows marks after all** (`win_dscp_probe.py` on DualRTX, Windows 11
26200.9457, not elevated, no QoS policy or registry setting; received on the
UM790Pro through two Freebox repeaters and their Wi-Fi 7 link):

| Method | Asked EF 46 | Asked AF41 34 | Asked CS6 48 |
|---|---|---|---|
| plain | 0 | 0 | 0 |
| `setsockopt(IP_TOS)` | **46** | **34** | refused (WSAEACCES) |
| `WSASendMsg` + `IP_TOS` per packet | **46** | **34** | refused |
| qWAVE `QOSAddSocketToFlow` (Voice) | 56 | 56 | 56 |
| qWAVE `QOSSetFlow(OutgoingDSCPValue)` | refused (error 5) | refused | refused |

- libjuice's Windows `udp_set_diffserv` gives up without trying
  (« IP_TOS has been intentionally broken on Windows… »): on this Windows the
  plain socket option works for a user process, below CS6.
- The DSCP crossed DualRTX → repeater → Wi-Fi 7 link → repeater → UM790Pro
  unchanged.
