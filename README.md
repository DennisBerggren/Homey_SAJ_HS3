# SAJ HS3 Control for Homey

Local monitoring and control of a **SAJ HS3** home battery over Modbus TCP – no cloud.
The register map is based on [stanus74/home-assistant-saj-h2-modbus](https://github.com/stanus74/home-assistant-saj-h2-modbus) (MIT), trimmed down to what matters for the HS3.

> **Status: test release.** Verified against one HS3 (12 kW, AIO3 module on WiFi). Feedback from other setups is very welcome – please open an issue.

## Read before installing

- **The AIO3 module accepts only a limited number of Modbus clients.** If Home Assistant (e.g. the SAJ H2 Modbus integration) or another system is already connected, Homey will be refused ("connection closed"). Only one of them can read at a time.
- **Tibber Smart control takes precedence.** When Smart control is on in the Tibber app, writes from Homey are accepted by the inverter but not acted on, and Tibber resets the operating mode. Control from Homey only works with Smart control off. Reading always works.
- The app is **read-only by default.** Set *Access → Read and write* in the device settings to use the action cards.

**Problems connecting?** See [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Questions and feedback: [Homey Community thread](https://community.homey.app/t/app-pro-saj-hs3-modbus/160710).

## What it shows

| Capability | Register | Note |
|---|---|---|
| Battery SOC | 0x406F | The 0xA000 battery block returns 0 on the HS3 and is not used |
| Battery power | 0x40A6 | Homey convention: + charging / − discharging (the HS3 reports the opposite; the app flips the sign) |
| Battery state | derived | charging / discharging / idle (±50 W) |
| Operating mode | 0x3647 | Self-use / Time-of-use / Backup / Passive |
| Min / max SOC | 0x3644 / 0x3646 | |
| Battery and inverter temperature | 0x406E / 0x4010 | |
| Charged / discharged total | 0x40CD / 0x40D5 | Used by Homey Energy |
| Inverter status and fault alarm | 0x4004–0x400A | Fault codes decoded |
| SAJ meter power (optional) | 0xA03F/45/4B | Sign not verified – use the "invert" setting if needed |

## Flow cards

- **When:** battery started charging/discharging/idling · operating mode changed
- **And:** battery state is … · operating mode is …
- **Then** (requires *Read and write*): charge at X W · discharge at X W · pause · release control · set operating mode · set SOC limits

### How charge/discharge works

The cards use SAJ's passive mode (0x3647 = 3, 0x3636 = 2/1/0). Power is written in per mille of rated power to both the battery limit (0x3639/0x363A) **and** the grid limit (0x3637/0x3638).

Tested on an HS3: with only the battery limit set, discharge ramped up past 5.8 kW. With the grid limit also set to the same value, it held steady at the requested ~2 kW. Charging from the grid is assumed to work the same way via 0x3637 but has not been verified.

*Pause* and *Release control* reset both grid limits to 100 %, so they never throttle other modes or Tibber. *Release control* restores the operating mode that was active before the app entered passive mode.

After every write the registers are read back. If a value didn't stick, the flow card fails with an error.

## Development

```
npm install -g homey
homey login
homey app run
homey app validate --level publish
```

---

## Svenska (kort)

Lokal övervakning och styrning av SAJ HS3 via Modbus TCP. AIO3-modulen släpper bara in ett begränsat antal Modbus-klienter, så Homey och t.ex. Home Assistant kan inte läsa samtidigt. Med Tibbers Smartstyrning påslagen tas skrivningar emot men ignoreras – styrning fungerar bara med Smartstyrning avstängd. Appen är skrivskyddad som standard.
