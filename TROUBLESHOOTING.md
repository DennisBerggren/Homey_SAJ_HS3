# SAJ HS3 Modbus – setup and troubleshooting

## Before you start

You need:
- A **SAJ HS3** with the **AIO3 communication module** (WiFi or LAN). The app talks to the AIO3 module over Modbus TCP on **port 502**.
- The **IP address** of the AIO3 module.
- Homey and the inverter on the **same network**.

### Find the IP address
1. Open your router's (or access point's) list of connected clients.
2. Look for a new device around the time the inverter was installed. The AIO3 module uses an Espressif WiFi chip, so the router may show it as *Espressif* or even guess a different brand from the MAC address (one of our test units showed up as "SolaX Power").
3. **Give it a fixed IP** (DHCP reservation) in the router. If the address changes, Homey loses contact.

### Check the connection from a computer (optional, but very useful)
On a Mac or Linux computer on the same network, run:

```
nc -vz <inverter IP> 502
```

- `succeeded` / `open` → the network path and port are fine. Continue in Homey.
- `timed out` → nothing answers at that address. See **"No answer"** below.
- `refused` → something answers, but port 502 is closed. See **"Refused"** below.

On Windows, use PowerShell: `Test-NetConnection <inverter IP> -Port 502`

---

## Error messages when adding the device

### "Homey got no answer from …" (or "… timed out")
Homey can't reach the inverter at all. Check, in this order:

1. **Is the IP correct?** Confirm it in the router's client list. It may have changed since you last looked.
2. **Same network?** If your router has separate networks or VLANs (for example an IoT network and a main network), Homey and the inverter must be able to reach each other. Try the `nc` test above from a computer on the *same* network as Homey.
3. **Is the AIO3 module online?** It is often connected to 2.4 GHz WiFi from outside or from a garage, where the signal can be weak. Check that it shows as connected in the router with a reasonable signal, and that the inverter is online in the Elekeeper app.
4. **Is port 502 open on your module?** On our test unit, Modbus TCP on port 502 was open by default. We don't yet know whether this is the case for every AIO3 firmware version. If the `nc` test times out even though the IP is right and the module is online, please report it in the community thread with your firmware version.

### "… refused the connection on that port"
Something answered at the IP, but not on port 502.
- Check that the port is **502**.
- Check that the IP really belongs to the SAJ inverter and not another device.

### "The inverter closed the Modbus connection …"
The AIO3 module only accepts a **limited number of Modbus clients at the same time**. If another system is already connected, Homey is turned away.

Typical culprits:
- **Home Assistant** with the *SAJ H2 Modbus* integration (it keeps its connection open all the time)
- Node-RED, Solar Assistant, EVCC or similar tools polling Modbus
- A second copy of this app on another Homey

Disable the other client, wait 30 seconds and try again. Only one of them can read the inverter.

Tibber's own connection (Tibber Bridge) does **not** block Homey on our test unit.

### "Connected, but the inverter did not answer the Modbus request"
- Check that **Modbus unit id** is **1**.
- The module may be busy; try again after a minute.

### "The inverter answered with Modbus error …"
The inverter replied, but not in the way the app expects. It may not be an HS3/H2-compatible model. Please post your exact model and firmware in the community thread.

---

## After the device has been added

### The device becomes unavailable after a while
- **The IP changed** → give the inverter a fixed IP and update it in *Device settings → Connection*.
- **Another Modbus client connected** (for example Home Assistant was restarted) → see "closed the Modbus connection" above.
- **WiFi drops** → if your network supports it, lock the inverter to the nearest access point, or use the inverter's LAN port if your setup allows it.

The device is marked unavailable after three failed reads in a row and recovers automatically once contact is back.

### Values look wrong
- **Battery power sign:** the app uses Homey's convention: **positive = charging**, **negative = discharging**.
- **SAJ meter power** (optional, off by default): the sign has not been verified on every installation. Use *Invert meter sign* in the device settings if import/export looks reversed.

### Action cards fail with "Writing is disabled"
The app is **read-only by default**. Go to *Device settings → Control → Access* and select **Read and write**.

### Charge/discharge commands do nothing, or the mode jumps back
This is almost always **Tibber Smart control** (or another energy manager) controlling the battery.
- With Tibber Smart control **on**, the inverter accepts the commands but ignores them, and Tibber sets its own operating mode.
- With Tibber Smart control **off**, the action cards work as expected.

There is currently no official way to switch Tibber Smart control on or off from Homey or Home Assistant.

### "The inverter did not keep the setting …"
The app reads every value back after writing it. This error means something else changed it right away, usually Tibber Smart control.

---

## Reporting a problem

Please post in the community thread and include:
- Inverter model and firmware version (from the Elekeeper app)
- How the inverter is connected (AIO3 WiFi, AIO3 LAN, Modbus converter)
- The exact error message in Homey
- The result of the `nc -vz <IP> 502` test, if you ran it
- Whether Home Assistant or another system also reads the inverter
