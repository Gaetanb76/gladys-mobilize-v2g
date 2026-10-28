# Mobilize Power V2G for Gladys Assistant

![Mobilize Power V2G in Gladys](../cover.jpg)

Follow in Gladys the charges and the energy sent back by your car on a **Mobilize Powerbox Verso** with the **Mobilize Power** offer: charging cost, V2G hours gain, subscription and balance, per day, month and year.

## Requirements

- A **Mobilize Powerbox Verso** on your local network (Wi-Fi or Ethernet), with a **fixed IP address** (set it in your router).
- The **password of the installer account** of the borne, printed on its label (user `installer`).

The integration reads the borne **read-only**: it never changes its settings and does not interfere with Mobilize Power or the My Renault app.

## Setup

1. **Configuration** tab: the borne's IP address, user and password, then **Test the connection to the Powerbox**. Gladys hides the password as you type it: this button confirms it is right ("OK") or refused.
2. Your contract's **subscribed power** (for the subscription).
3. **Discovery** tab: create the "Mobilize Power V2G" device.
4. Dashboard: add the **V2G balance** widget and pick the period (today, this month, this year).

### Updating from version 0.1

Version 0.1 misread the car's presence (always "plugged") and declared features Gladys duplicated as "(consumption)" and "(cost)". After the update, delete the "Mobilize Power V2G" device (**Devices** tab) and create it again from the **Discovery** tab. The V2G hours estimated before the update are reset; the energy and the official hours you entered are kept.

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

The **V2G hours are estimated** from the time the car is plugged in (Mobilize counts them only once the minimum charge level is reached and until the departure time). The car is detected on the socket's control pilot: a cable left in the borne without a car does not count. Enter the official figure of a month with the **Official V2G hours** button of the widget, or the action of the same name in the configuration.

## Limits

- The borne's local API is not documented by Mobilize: a firmware update could change it.
- If the borne or Gladys is unreachable for more than 10 minutes, that time is not counted as V2G hours; the energy is caught up thanks to the borne's counters.
- Amounts are TTC (taxes included), computed with the grid prices: the invoice may differ slightly.
- In **Discovery**, Gladys shows a "$" icon for every currency feature whatever the currency: the amounts are in euros (unit €).
