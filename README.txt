Monitor and control your SAJ HS3 home battery locally over Modbus TCP – no cloud needed.

The app shows battery state of charge, battery power, whether the battery is charging, discharging or idle, the operating mode, SOC limits, battery and inverter temperature, total charged and discharged energy for Homey Energy, and inverter status with fault alarms.

Flow cards let you react when the battery starts charging or discharging, or when the operating mode changes. With write access enabled you can charge or discharge at a set power, pause the battery, release control, change the operating mode and set SOC limits.

Good to know before you install:
- The app connects to the inverter's AIO3 module (or a Modbus TCP converter) on port 502. The AIO3 module only accepts a limited number of Modbus clients, so Homey and for example Home Assistant cannot read it at the same time.
- If Tibber Smart control is enabled, Tibber takes precedence and commands from Homey are ignored. Reading always works.
- The app is read-only by default. Enable "Read and write" in the device settings to use the action cards.

This is a community app and is not affiliated with SAJ. Tested on a 12 kW SAJ HS3; feedback from other setups is welcome on GitHub.
