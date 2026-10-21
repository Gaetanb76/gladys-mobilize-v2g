# Mobilize Power V2G for Gladys Assistant

![Mobilize Power V2G in Gladys](../cover.jpg)

Follow in Gladys the charges and the energy sent back by your car on a **Mobilize Powerbox Verso** with the **Mobilize Power** offer: charging cost, V2G hours gain, subscription and balance, per day, month and year.

## Requirements

- A **Mobilize Powerbox Verso** on your local network (Wi-Fi or Ethernet), with a **fixed IP address** (set it in your router).
- The **password of the installer account** of the borne, printed on its label (user `installer`).

The integration reads the borne **read-only**: it never changes its settings and does not interfere with Mobilize Power or the My Renault app.

## Setup

1. **Configuration** tab: the borne's IP address, user and password, then **Test the connection to the Powerbox**.
2. Your contract's **subscribed power** (for the subscription).
3. **Discovery** tab: create the "Mobilize Power V2G" device.
4. Dashboard: add the **V2G balance** widget and pick the period (today, this month, this year).

## The calculation

| Line | Calculation |
|---|---|
| Charging cost | kWh charged × price per kWh |
| Subscription | annual subscription × days of the period ÷ days of the year |
| V2G bonus | V2G hours × V2G Hour rate |
| Buyback of the energy sent back | kWh sent back × buyback price (0 by default) |
| **Balance** | charging + subscription − V2G bonus − buyback |

A negative balance is a gain.

The tariffs come from the grid published on [mobilize-v2g.fr](https://www.mobilize-v2g.fr/fr_fr), read once a day (built-in fallback: the August 2026 grid). A value entered in the configuration always wins over the grid.

The **V2G hours are estimated** from the time the car is plugged in (Mobilize counts them only once the minimum charge level is reached and until the departure time). Enter the official figure of a month with the **Official V2G hours** button of the widget, or the action of the same name in the configuration.

## Limits

- The borne's local API is not documented by Mobilize: a firmware update could change it.
- If the borne or Gladys is unreachable for more than 10 minutes, that time is not counted as V2G hours; the energy is caught up thanks to the borne's counters.
- Amounts are TTC (taxes included), computed with the grid prices: the invoice may differ slightly.
